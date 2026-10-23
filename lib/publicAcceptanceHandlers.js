// lib/publicAcceptanceHandlers.js — SOLO servidor (rutas /api/public/quotes/**).
// Lógica de las tres rutas públicas con dependencias INYECTADAS: `deps = { admin, env, now, log, limits, timeouts }`.
// Las rutas pasan `supabaseAdmin` (service_role, solo servidor) y `process.env`; las pruebas pasan un cliente simulado.
//
// Garantías (ver CONTRATOS-aceptacion-publica.md y INFORME de la capa de servidor):
//  - Solo se llama a get_public_quote_by_token y accept_quote_by_token (EXECUTE solo para service_role) y a public_rate_hit.
//    Nunca se invoca el núcleo contractual ni ensure_quote_acceptance_token.
//  - Las respuestas se construyen con listas blancas positivas; no se reenvía el objeto de la RPC, ni `server_only`, ni errores crudos.
//  - Ante un resultado desconocido (tiempo agotado, red, respuesta malformada) NUNCA se informa éxito ni se reintenta accept.
//  - Falla cerrada: sin secreto de nonce configurado o con cupos no verificables no se atiende la solicitud.
import { apiKeyHeaders } from './supabaseApiKey'
import {
  TOKEN_RE, DEFAULT_LIMITS, DEFAULT_TIMEOUTS, LOGO_BUCKET, NONCE_TTL_MS, MAX_LOGO_BYTES,
  jsonResponse, errorResponse, SECURITY_HEADERS,
  readConfig, checkOrigin, isJsonContentType, readBodyLimited, parseAcceptBody,
  signNonce, verifyNonce, bucketFor, INVALID_BUCKET, validRateResult,
  sanitizeGetResult, sanitizeAcceptResult, validateLogoPath, sniffLogo,
} from './publicAcceptance'

const SQLSTATE_RE = /^[0-9A-Z]{5}$/

// Una RPC con tiempo máximo. Devuelve { data, error } tal cual, o { unknown:true } si venció el tiempo o la llamada lanzó.
async function callRpc(admin, name, args, ms) {
  const ac = new AbortController()
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => { ac.abort(); resolve({ unknown: true }) }, ms) })
  try {
    const q = admin.rpc(name, args)
    const call = typeof q.abortSignal === 'function' ? q.abortSignal(ac.signal) : q
    const r = await Promise.race([Promise.resolve(call), timeout])
    return r && r.unknown ? { unknown: true } : r
  } catch {
    return { unknown: true }
  } finally {
    clearTimeout(timer)
  }
}

// Un error con SQLSTATE de 5 caracteres lo devolvió PostgreSQL tras revertir la transacción de la función: no quedó nada registrado.
// Cualquier otra cosa (sin código, PGRST*, abortos, red) deja el resultado DESCONOCIDO.
const knownDbFailure = (r) => !!r && !!r.error && typeof r.error.code === 'string' && SQLSTATE_RE.test(r.error.code)

const ctx = (deps) => ({
  limits: { ...DEFAULT_LIMITS, ...(deps.limits || {}) },
  timeouts: { ...DEFAULT_TIMEOUTS, ...(deps.timeouts || {}) },
  now: deps.now || (() => Date.now()),
  log: deps.log || (() => {}),
})

// Cupo en la base (llamada independiente de la transacción de aceptación). → { ok:true, allowed, retryAfter } | { ok:false }
async function rateHit(deps, c, bucket, rule) {
  const r = await callRpc(deps.admin, 'public_rate_hit', { p_bucket: bucket, p_window_seconds: rule.windowSec, p_limit: rule.limit }, c.timeouts.rateMs)
  if (r.unknown || r.error || !validRateResult(r.data)) return { ok: false }
  return { ok: true, allowed: r.data.allowed, retryAfter: r.data.retry_after }
}

const limited = (retryAfter) => errorResponse('rate_limited', 429, { retry_after: retryAfter }, { 'Retry-After': String(retryAfter) })
const invalidToken = (key) => jsonResponse({ [key]: 'invalid' }, 404)

// ---------------------------------------------------------------------------
// GET /api/public/quotes/[token]  → estado de la cotización (lista blanca) y, si está abierta, un nonce firmado
// ---------------------------------------------------------------------------
export async function handleGetQuote(request, token, deps) {
  const c = ctx(deps), t0 = c.now()
  const done = (res, outcome, rpcCode = null) => { c.log('get', { outcome, http: res.status, rpcCode, ms: c.now() - t0 }); return res }
  const cfg = readConfig(deps.env)
  if (!cfg.ok) return done(errorResponse('service_unavailable', 503), 'misconfigured')
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return done(invalidToken('state'), 'bad_token_shape')

  // ORDEN (revisión final): 1) get (lectura barata por índice único del token) → 2) si el token NO existe, un único cupo GLOBAL (una fila
  // por ventana: los tokens inventados no crean filas por token) → 3) si existe, el cupo por token. Así la tabla de contadores solo
  // crece con tokens reales y la escritura por solicitud inválida es siempre sobre la misma fila.
  const r = await callRpc(deps.admin, 'get_public_quote_by_token', { p_token: token }, c.timeouts.getMs)
  if (r.unknown || r.error) return done(errorResponse('service_unavailable', 503), 'rpc_failed', r.error && SQLSTATE_RE.test(r.error.code || '') ? r.error.code : null)
  const out = sanitizeGetResult(r.data)
  if (!out.ok) return done(errorResponse('service_unavailable', 503), 'rpc_malformed')

  if (out.body.state === 'invalid') {
    const g = await rateHit(deps, c, INVALID_BUCKET, c.limits.invalid)
    if (!g.ok) return done(errorResponse('service_unavailable', 503), 'rate_unverifiable')
    if (!g.allowed) return done(limited(g.retryAfter), 'invalid_rate_limited')
    return done(jsonResponse(out.body, 404), 'invalid')
  }
  const rl = await rateHit(deps, c, bucketFor('get', token), c.limits.get)
  if (!rl.ok) return done(errorResponse('service_unavailable', 503), 'rate_unverifiable')
  if (!rl.allowed) return done(limited(rl.retryAfter), 'rate_limited')

  if (out.body.state === 'open') {
    const now = c.now()
    const expiresMs = Date.parse(out.body.expires_at)
    const nonceExp = Math.min(now + NONCE_TTL_MS, Number.isFinite(expiresMs) ? expiresMs : now + NONCE_TTL_MS)
    if (nonceExp <= now) return done(errorResponse('service_unavailable', 503), 'clock_skew')   // el reloj de la base y el del servidor web discrepan: no se emite un nonce ya vencido
    out.body.nonce = signNonce({ secret: cfg.secret, token, revision: out.body.revision, expiresAtMs: nonceExp })
    out.body.nonce_expires_at = new Date(nonceExp).toISOString()
    out.body.logo = validateLogoPath(r.data && r.data.server_only && r.data.server_only.logo_path, out.body.revision) !== null
  }
  return done(jsonResponse(out.body, 200), out.body.state)
}

// ---------------------------------------------------------------------------
// POST /api/public/quotes/[token]/accept
// ---------------------------------------------------------------------------
export async function handleAcceptQuote(request, token, deps) {
  const c = ctx(deps), t0 = c.now()
  const done = (res, outcome, rpcCode = null) => { c.log('accept', { outcome, http: res.status, rpcCode, ms: c.now() - t0 }); return res }
  const cfg = readConfig(deps.env)
  if (!cfg.ok) return done(errorResponse('service_unavailable', 503), 'misconfigured')

  if (!checkOrigin(request, cfg.allowedOrigins)) return done(errorResponse('bad_origin', 403), 'bad_origin')
  if (!isJsonContentType(request)) return done(errorResponse('unsupported_media_type', 415), 'bad_content_type')
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return done(invalidToken('status'), 'bad_token_shape')

  const body = await readBodyLimited(request)
  if (!body.ok) return done(body.reason === 'too_large' ? errorResponse('payload_too_large', 413) : jsonResponse({ status: 'invalid_input', field: 'body' }, 400), 'body_' + body.reason)
  const parsed = parseAcceptBody(body.text)
  if (!parsed.ok) return done(jsonResponse({ status: 'invalid_input', field: parsed.field }, 400), 'invalid_input')
  const { revision, name, nonce } = parsed.value

  // Nonce ligado a ESTE token y a ESTA revisión (la del cuerpo). Alterado, de otro token/revisión o vencido → 403 sin tocar la base.
  const nv = verifyNonce({ secret: cfg.secret, token, revision, nonce, nowMs: c.now() })
  if (!nv.ok) return done(errorResponse(nv.reason === 'expired' ? 'nonce_expired' : 'nonce_invalid', 403), 'nonce_' + nv.reason)

  const rl = await rateHit(deps, c, bucketFor('accept', token), c.limits.accept)
  if (!rl.ok) return done(errorResponse('service_unavailable', 503), 'rate_unverifiable')
  if (!rl.allowed) return done(limited(rl.retryAfter), 'rate_limited')

  // Una sola llamada a accept por solicitud; jamás se reintenta automáticamente.
  const r = await callRpc(deps.admin, 'accept_quote_by_token', {
    p_token: token, p_revision: revision, p_name: name, p_consent: true, p_consent_version: 1,
  }, c.timeouts.acceptMs)
  if (r.unknown || (r.error && !knownDbFailure(r))) return done(errorResponse('result_unknown', 503), 'result_unknown')
  if (r.error) return done(errorResponse('temporarily_unavailable', 503), 'db_failure', r.error.code)

  const out = sanitizeAcceptResult(r.data)
  if (!out) return done(errorResponse('result_unknown', 503), 'result_malformed')       // respuesta inesperada: no se afirma nada

  if (r.data.status === 'invalid') {
    const g = await rateHit(deps, c, INVALID_BUCKET, c.limits.invalid)
    if (g.ok && !g.allowed) return done(limited(g.retryAfter), 'invalid_rate_limited')
  }
  return done(jsonResponse(out.body, out.http), r.data.status)
}

// ---------------------------------------------------------------------------
// GET /api/public/quotes/[token]/logo  → bytes del logo de la revisión abierta, desde una ruta interna VALIDADA
// ---------------------------------------------------------------------------
export async function handleGetLogo(request, token, deps) {
  const c = ctx(deps), t0 = c.now()
  const done = (res, outcome, rpcCode = null) => { c.log('logo', { outcome, http: res.status, rpcCode, ms: c.now() - t0 }); return res }
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return done(invalidToken('state'), 'bad_token_shape')
  if (typeof deps.readObject !== 'function') return done(errorResponse('service_unavailable', 503), 'misconfigured')

  // Mismo orden que la consulta: get → (inexistente: cupo global) → cupo por token → descarga (la parte cara solo con cupo disponible).
  const r = await callRpc(deps.admin, 'get_public_quote_by_token', { p_token: token }, c.timeouts.getMs)
  if (r.unknown || r.error) return done(errorResponse('service_unavailable', 503), 'rpc_failed')
  const out = sanitizeGetResult(r.data)
  if (!out.ok) return done(errorResponse('service_unavailable', 503), 'rpc_malformed')
  if (out.body.state === 'invalid') {
    const g = await rateHit(deps, c, INVALID_BUCKET, c.limits.invalid)
    if (!g.ok) return done(errorResponse('service_unavailable', 503), 'rate_unverifiable')
    if (!g.allowed) return done(limited(g.retryAfter), 'invalid_rate_limited')
    return done(invalidToken('state'), 'invalid')
  }
  const rl = await rateHit(deps, c, bucketFor('logo', token), c.limits.logo)
  if (!rl.ok) return done(errorResponse('service_unavailable', 503), 'rate_unverifiable')
  if (!rl.allowed) return done(limited(rl.retryAfter), 'rate_limited')

  if (out.body.state !== 'open') return done(errorResponse('logo_unavailable', 404), 'not_open')
  const path = validateLogoPath(r.data.server_only && r.data.server_only.logo_path, out.body.revision)
  if (!path) return done(errorResponse('logo_unavailable', 404), 'no_valid_logo_path')   // sin logo, o ruta que no es la interna de esta revisión

  let bytes = null
  try {
    const rd = await Promise.race([
      deps.readObject(LOGO_BUCKET, path, MAX_LOGO_BYTES),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false }), c.timeouts.getMs)),
    ])
    if (rd && rd.ok === true && rd.bytes instanceof Uint8Array) bytes = rd.bytes
  } catch { bytes = null }
  const type = bytes ? sniffLogo(bytes) : null
  if (!type) return done(errorResponse('logo_unavailable', 404), 'logo_rejected')
  return done(new Response(bytes, { status: 200, headers: { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': String(bytes.length) } }), 'logo_ok')
}

// ---------------------------------------------------------------------------
// Lector de objetos INTERNOS de Storage para el logo. Solo construye la URL a partir de la configuración fija (NEXT_PUBLIC_SUPABASE_URL),
// el bucket fijo y una ruta ya validada (uuid/uuid.logo). NUNCA sigue redirecciones (redirect:'manual': cualquier 3xx es un fallo),
// Cabeceras de autenticación según el formato de clave (supabaseApiKey.js): legacy JWT → apikey + Bearer; secret key → SOLO apikey.
// limita el tiempo y lee el cuerpo en flujo con un tope duro (no descarga más de maxBytes+1 aunque Storage anuncie o envíe más).
// → { ok:true, bytes } | { ok:false, reason }
// ---------------------------------------------------------------------------
export function createStorageReader({ baseUrl, serviceKey, fetchImpl, timeoutMs = 8000 }) {
  return async function readObject(bucket, path, maxBytes) {
    let timer
    const ac = new AbortController()
    const deadline = new Promise((resolve) => { timer = setTimeout(() => { ac.abort(); resolve({ ok: false, reason: 'timeout' }) }, timeoutMs) })
    const work = (async () => {
      if (typeof serviceKey !== 'string' || !serviceKey) return { ok: false, reason: 'config' }
      if (typeof bucket !== 'string' || !/^[a-z0-9_-]+$/.test(bucket)) return { ok: false, reason: 'path' }
      // ruta: segmentos simples, sin '.', '..', vacíos, '?', '#', '%' ni espacios (el formato real es quotes/{uuid}/revisions/{uuid}.logo)
      if (typeof path !== 'string' || !/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/.test(path) || path.split('/').some((seg) => seg === '.' || seg === '..')) return { ok: false, reason: 'path' }
      const base = new URL(baseUrl)
      if (!/^https?:$/.test(base.protocol)) return { ok: false, reason: 'config' }
      const url = base.origin + '/storage/v1/object/' + encodeURIComponent(bucket) + '/' + path.split('/').map(encodeURIComponent).join('/')
      const res = await (fetchImpl || fetch)(url, { method: 'GET', redirect: 'manual', cache: 'no-store', headers: apiKeyHeaders(serviceKey), signal: ac.signal })
      const stop = async (reason) => { try { await res.body?.cancel() } catch { /* ya cerrado */ } return { ok: false, reason } }
      if (res.status >= 300 && res.status < 400) return stop('redirect')
      if (res.status !== 200 || res.redirected) return stop('status')
      const cl = res.headers.get('content-length')
      if (cl !== null && (!/^\d+$/.test(cl) || Number(cl) > maxBytes)) return stop('too_large')
      if (!res.body) return { ok: false, reason: 'empty' }
      const reader = res.body.getReader()
      const chunks = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) { await reader.cancel().catch(() => {}); return { ok: false, reason: 'too_large' } }
        chunks.push(value)
      }
      const bytes = new Uint8Array(total)
      let off = 0
      for (const ch of chunks) { bytes.set(ch, off); off += ch.byteLength }
      return { ok: true, bytes }
    })().catch(() => ({ ok: false, reason: 'error' }))
    try { return await Promise.race([work, deadline]) } finally { clearTimeout(timer) }
  }
}
