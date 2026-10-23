// lib/publicAcceptance.js — SOLO servidor (rutas /api/public/quotes/**).
// Fase 6.7 / bloque 5 — capa de servidor para la consulta y la aceptación pública de cotizaciones.
//
// Este módulo es PURO: no importa credenciales ni el cliente admin. Las rutas le pasan `supabaseAdmin` (ver
// publicAcceptanceHandlers.js). Contiene lo que el contrato de la migración 4 deja a la API: validación de la forma del token y
// del cuerpo, comprobación de Origin, nonce firmado (HMAC), listas blancas de campos, cabeceras de respuesta y bloques de cupos.
// Contratos de referencia: CONTRATOS-aceptacion-publica.md (§2.3 lista blanca, §3 accept, §8 frontera SQL/API).
//
// El token del enlace es un ACCESO CONFIDENCIAL: nunca se registra, nunca se devuelve y solo se usa como argumento de las RPC.
import 'server-only'
import crypto from 'crypto'

export const TOKEN_RE = /^[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX8_RE = /^[0-9a-f]{8}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/

export const CONSENT_VERSION = 1
// Texto exacto aprobado para consent_version = 1 (CONTRATOS §6). SHA-256 (UTF-8): 45f14d91dd65383986f0f1f0345f137e7dd5f330e7296a44de369baca6604786
export const CONSENT_TEXT_V1 = 'He revisado esta versión de la cotización y acepto sus conceptos, importes y condiciones.'
export const STALE_LINK_NOTICE = 'Este enlace corresponde a una versión anterior. Revisa la versión vigente antes de aceptarla.'

export const MAX_BODY_BYTES = 2048
export const NONCE_TTL_MS = 30 * 60 * 1000
export const MIN_SECRET_LENGTH = 32
export const MAX_LOGO_BYTES = 1024 * 1024
export const LOGO_BUCKET = 'quote_documents'

// Cupos iniciales aprobados (DISENO-FINAL §6): get 60/min por token; accept 10 intentos/10 min por token; búsquedas inválidas
// 120/min globales. El logo tiene su propio cupo para no agotar el de consulta.
export const DEFAULT_LIMITS = {
  get: { limit: 60, windowSec: 60 },
  logo: { limit: 30, windowSec: 60 },
  accept: { limit: 10, windowSec: 600 },
  invalid: { limit: 120, windowSec: 60 },
}
export const DEFAULT_TIMEOUTS = { rateMs: 3000, getMs: 8000, acceptMs: 10000 }

// ---------------------------------------------------------------------------
// Cabeceras: toda respuesta (incluidos los errores) lleva no-store, noindex y no-referrer. El token del enlace es confidencial.
// ---------------------------------------------------------------------------
export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

export function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  })
}

export function errorResponse(code, status, extra = {}, headers = {}) {
  return jsonResponse({ error: code, message: ERROR_MESSAGES[code] || ERROR_MESSAGES.service_unavailable, ...extra }, status, headers)
}

// Mensajes fijos y genéricos: nunca se propaga texto de la base ni del runtime.
export const ERROR_MESSAGES = {
  method_not_allowed: 'Método no permitido.',
  bad_origin: 'Origen no permitido.',
  unsupported_media_type: 'Tipo de contenido no admitido.',
  payload_too_large: 'La solicitud es demasiado grande.',
  nonce_invalid: 'El formulario no es válido. Recarga la página e inténtalo de nuevo.',
  nonce_expired: 'El formulario venció. Recarga la página e inténtalo de nuevo.',
  rate_limited: 'Demasiadas solicitudes. Inténtalo de nuevo en unos minutos.',
  service_unavailable: 'El servicio no está disponible por ahora. Inténtalo de nuevo más tarde.',
  temporarily_unavailable: 'No se pudo completar la operación. No se registró ningún cambio. Inténtalo de nuevo.',
  result_unknown: 'No pudimos confirmar el resultado. Recarga la página para ver el estado actual antes de reintentar.',
  logo_unavailable: 'Logo no disponible.',
}

export function methodNotAllowed(allow) {
  return errorResponse('method_not_allowed', 405, {}, { Allow: allow })
}

// ---------------------------------------------------------------------------
// Configuración (solo desde el entorno que pasa la ruta; nunca se lee ni se registra el valor del secreto)
// ---------------------------------------------------------------------------
// PUBLIC_ACCEPT_NONCE_SECRET: secreto del nonce (>= 32 caracteres). CONFIGURACIÓN FUTURA: no existe en ningún entorno real todavía.
// PUBLIC_ACCEPT_ALLOWED_ORIGINS: OBLIGATORIA. Lista separada por comas de orígenes completos exactos (https://dominio). Los orígenes
//   permitidos salen SOLO de esta configuración: nunca de Host, X-Forwarded-* ni de la URL de la solicitud (cabeceras que un cliente
//   o un proxy mal configurado pueden fijar). Ausente o mal formada → falla cerrada.
export function readConfig(env) {
  const secret = env && env.PUBLIC_ACCEPT_NONCE_SECRET
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) return { ok: false }
  const raw = env.PUBLIC_ACCEPT_ALLOWED_ORIGINS
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false }
  const allowedOrigins = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (allowedOrigins.length === 0 || allowedOrigins.some((o) => !isPlainOrigin(o))) return { ok: false }
  return { ok: true, secret, allowedOrigins }
}

function isPlainOrigin(o) {
  try { return new URL(o).origin === o && /^https?:$/.test(new URL(o).protocol) } catch { return false }
}

// ---------------------------------------------------------------------------
// Origin: las operaciones que modifican exigen un Origin presente y que coincida EXACTAMENTE con la lista configurada. Un POST «simple»
// entre sitios (text/plain) no dispara preflight; por eso además se exige application/json.
// ---------------------------------------------------------------------------
export function checkOrigin(request, allowedOrigins) {
  const origin = request.headers.get('origin')
  if (!origin || !isPlainOrigin(origin)) return false
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0 || !allowedOrigins.includes(origin)) return false
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin') return false
  return true
}

export function isJsonContentType(request) {
  const ct = String(request.headers.get('content-type') || '').toLowerCase()
  return /^application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/.test(ct)
}

// ---------------------------------------------------------------------------
// Cuerpo: límite estricto de tamaño leyendo el flujo (no se confía en Content-Length)
// ---------------------------------------------------------------------------
export async function readBodyLimited(request, maxBytes = MAX_BODY_BYTES) {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return { ok: false, reason: 'too_large' }
  if (!request.body) return { ok: false, reason: 'empty' }
  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) { await reader.cancel().catch(() => {}); return { ok: false, reason: 'too_large' } }
      chunks.push(value)
    }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (total === 0) return { ok: false, reason: 'empty' }
  const bytes = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { bytes.set(c, off); off += c.byteLength }
  try { return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } } catch { return { ok: false, reason: 'unreadable' } }
}

// ---------------------------------------------------------------------------
// Validación de entradas de accept. Replica las reglas del contrato (el SQL sigue siendo la autoridad): nunca se llega a la base con
// entradas que ya se sabe inválidas.
// ---------------------------------------------------------------------------
// Rangos prohibidos (CONTRATOS §3): controles C0/C1, invisibles y separadores. Se construyen con códigos numéricos.
const FORBIDDEN_RANGES = [[0x01, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff]]
const SPACE_CODES = new Set([0x20, 0xa0])

export function normalizeName(raw) {
  if (typeof raw !== 'string' || raw.length > 400) return null
  const out = []
  let lastSpace = true                                  // recorta al inicio
  for (const ch of raw) {
    const c = ch.codePointAt(0)
    if (FORBIDDEN_RANGES.some(([a, b]) => c >= a && c <= b)) return null
    if (SPACE_CODES.has(c)) { if (!lastSpace) { out.push(' '); lastSpace = true } } else { out.push(ch); lastSpace = false }
  }
  while (out.length && out[out.length - 1] === ' ') out.pop()
  return out.length >= 2 && out.length <= 120 ? out.join('') : null
}

const ACCEPT_KEYS = new Set(['revision', 'name', 'consent', 'consent_version', 'nonce'])

// → { ok:true, value:{revision, name, nonce} } | { ok:false, field }
export function parseAcceptBody(text) {
  let obj
  try { obj = JSON.parse(text) } catch { return { ok: false, field: 'body' } }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, field: 'body' }
  for (const k of Object.keys(obj)) if (!ACCEPT_KEYS.has(k)) return { ok: false, field: 'body' }
  if (typeof obj.revision !== 'string' || !UUID_RE.test(obj.revision)) return { ok: false, field: 'revision' }
  if (obj.consent !== true) return { ok: false, field: 'consent' }
  if (obj.consent_version !== CONSENT_VERSION) return { ok: false, field: 'consent_version' }
  const name = normalizeName(obj.name)
  if (name === null) return { ok: false, field: 'name' }
  if (typeof obj.nonce !== 'string' || obj.nonce.length > 100) return { ok: false, field: 'nonce' }
  return { ok: true, value: { revision: obj.revision.toLowerCase(), name, nonce: obj.nonce } }
}

// ---------------------------------------------------------------------------
// Nonce firmado: v1.<exp en segundos>.<HMAC-SHA256 base64url>. Ligado a token Y revisión. La clave se deriva del secreto con
// separación de dominio. Frena POST ciegos y automatización simple; no es un secreto de seguridad por sí mismo.
// ---------------------------------------------------------------------------
const NONCE_RE = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/

function nonceMac(secret, token, revision, expSec) {
  const key = crypto.createHmac('sha256', secret).update('doneware:public-accept-nonce:v1').digest()
  return crypto.createHmac('sha256', key).update(`v1|${token}|${String(revision).toLowerCase()}|${expSec}`).digest('base64url')
}

export function signNonce({ secret, token, revision, expiresAtMs }) {
  const expSec = Math.floor(expiresAtMs / 1000)
  return `v1.${expSec}.${nonceMac(secret, token, revision, expSec)}`
}

// → { ok:true } | { ok:false, reason:'invalid'|'expired' }
export function verifyNonce({ secret, token, revision, nonce, nowMs }) {
  const m = typeof nonce === 'string' ? NONCE_RE.exec(nonce) : null
  if (!m) return { ok: false, reason: 'invalid' }
  const expSec = Number(m[1])
  const expected = Buffer.from(nonceMac(secret, token, revision, expSec))
  const given = Buffer.from(m[2])
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return { ok: false, reason: 'invalid' }
  if (expSec * 1000 <= nowMs) return { ok: false, reason: 'expired' }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Cupos: la clave es una huella SHA-256 truncada del token (nunca el token). El contador vive en la base (public_rate_hit).
// ---------------------------------------------------------------------------
export function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 32)
}
export const bucketFor = (action, token) => `${action}:${tokenFingerprint(token)}`
export const INVALID_BUCKET = 'invalid:global'

export function validRateResult(r) {
  return !!r && typeof r === 'object' && typeof r.allowed === 'boolean' && Number.isInteger(r.retry_after) && r.retry_after >= 1 && r.retry_after <= 86400
}

// ---------------------------------------------------------------------------
// Listas blancas POSITIVAS. Se copia solo lo que se nombra, con comprobación de tipo y tamaño; todo lo demás se descarta
// (incluida `server_only`). Nunca se reenvía el objeto de la RPC.
// ---------------------------------------------------------------------------
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
const str = (max) => (x) => (typeof x === 'string' && x.length <= max ? x : undefined)
const nstr = (max) => (x) => (x === null ? null : str(max)(x))
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
const nnum = (x) => (x === null ? null : num(x))
const bool = (x) => (typeof x === 'boolean' ? x : undefined)
const uuid = (x) => (typeof x === 'string' && UUID_RE.test(x) ? x.toLowerCase() : undefined)
const hex8 = (x) => (typeof x === 'string' && HEX8_RE.test(x) ? x : undefined)
const dateStr = (x) => (typeof x === 'string' && DATE_RE.test(x) ? x : undefined)
const tsStr = (x) => (typeof x === 'string' && x.length <= 40 && TS_RE.test(x) ? x : undefined)
const ntsStr = (x) => (x === null ? null : tsStr(x))
const numOrStrOrNull = (x) => (x === null ? null : typeof x === 'number' ? num(x) : str(40)(x))
const one = (...allowed) => (x) => (allowed.includes(x) ? x : undefined)

function pick(obj, spec) {
  const out = {}
  if (!isObj(obj)) return out
  for (const [k, fn] of Object.entries(spec)) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) { const v = fn(obj[k]); if (v !== undefined) out[k] = v }
  }
  return out
}

const COMPANY_SPEC = { company_name: nstr(200), phone: nstr(60), email: nstr(200), address: nstr(400), website: nstr(200), terms: nstr(5000) }
const ITEM_SPEC = { name: str(300), unit: nstr(40), qty: num, price: num, subtotal: num }
const DOC_SPEC = {
  folio: str(40), created_at: nstr(40), discount_type: nstr(20), discount_value: nnum, discount: nnum, subtotal: nnum, iva_rate: nnum, apply_iva: bool, iva: nnum,
  total: nnum, install_time_value: numOrStrOrNull, install_time_unit: nstr(40), notes: nstr(5000), quote_type: nstr(20), requires_service: bool,
}
const MAX_ITEMS = 300

export function sanitizeDoc(doc) {
  if (!isObj(doc)) return undefined
  const out = pick(doc, DOC_SPEC)
  if (isObj(doc.company)) out.company = pick(doc.company, COMPANY_SPEC)
  if (isObj(doc.client)) out.client = pick(doc.client, { name: str(200) })
  if (Array.isArray(doc.items)) out.items = doc.items.slice(0, MAX_ITEMS).filter(isObj).map((it) => pick(it, ITEM_SPEC))
  if (doc.requires_service === true && typeof doc.service_address === 'string') { const a = str(400)(doc.service_address); if (a !== undefined) out.service_address = a }
  return out
}

// Estados de `get` y campos que se pueden reenviar (CONTRATOS §2.3). `required` = campos sin los cuales la respuesta se considera
// malformada (no se reenvía a medias).
const GET_STATES = {
  invalid: { spec: {}, required: [] },
  unpublished: { spec: { folio: str(40), company_name: nstr(200) }, required: ['folio'] },
  unavailable: { spec: { folio: str(40), company_name: nstr(200) }, required: ['folio'] },
  contracted: { spec: { folio: str(40), company_name: nstr(200) }, required: ['folio'] },
  cancelled: { spec: { folio: str(40), company_name: nstr(200) }, required: ['folio'] },
  expired: { spec: { folio: str(40), company_name: nstr(200), valid_until: dateStr }, required: ['folio', 'valid_until'] },
  open: { spec: { revision: uuid, revision_code: hex8, published_at: ntsStr, valid_until: dateStr, expires_at: tsStr, consent_version: one(CONSENT_VERSION) }, required: ['revision', 'revision_code', 'valid_until', 'expires_at', 'consent_version'] },
  accepted: { spec: { accepted_at: tsStr, accepted_by_name: str(120), revision_code: hex8, folio: str(40), company_name: nstr(200) }, required: ['accepted_at', 'revision_code', 'folio'] },
}

// → { ok:true, body } | { ok:false }   (body NO incluye nonce; lo añade el manejador solo en `open`)
export function sanitizeGetResult(rpc) {
  if (!isObj(rpc) || typeof rpc.state !== 'string' || !Object.prototype.hasOwnProperty.call(GET_STATES, rpc.state)) return { ok: false }
  const def = GET_STATES[rpc.state]
  const body = { state: rpc.state, ...pick(rpc, def.spec) }
  if (def.required.some((k) => body[k] === undefined)) return { ok: false }
  if (rpc.state === 'open' || rpc.state === 'accepted') {
    const doc = sanitizeDoc(rpc.doc)
    if (rpc.state === 'open' && doc === undefined) return { ok: false }
    if (doc !== undefined) body.doc = doc
  }
  return { ok: true, body }
}

// Resultados de accept → { http, body } (campos reenviables por estado). Todo estado desconocido o malformado → null (resultado no confiable).
const ACCEPT_STATES = {
  accepted: { http: 200, spec: { accepted_at: tsStr, revision_code: hex8 }, required: ['accepted_at', 'revision_code'] },
  already_accepted: { http: 200, spec: { accepted_at: tsStr, revision_code: hex8, requested_revision_matches: bool }, required: ['accepted_at', 'revision_code', 'requested_revision_matches'] },
  quote_changed: { http: 409, spec: { revision: uuid, revision_code: hex8 }, required: ['revision', 'revision_code'] },
  invalid_input: { http: 400, spec: { field: one('revision', 'consent', 'consent_version', 'name') }, required: ['field'] },
  invalid: { http: 404, spec: {}, required: [] },
  expired: { http: 410, spec: { valid_until: dateStr }, required: ['valid_until'] },
  cancelled: { http: 410, spec: {}, required: [] },
  contracted: { http: 409, spec: {}, required: [] },
  unpublished: { http: 409, spec: {}, required: [] },
  unavailable: { http: 409, spec: {}, required: [] },
}

export function sanitizeAcceptResult(rpc) {
  if (!isObj(rpc) || typeof rpc.status !== 'string' || !Object.prototype.hasOwnProperty.call(ACCEPT_STATES, rpc.status)) return null
  const def = ACCEPT_STATES[rpc.status]
  const body = { status: rpc.status, ...pick(rpc, def.spec) }
  if (def.required.some((k) => body[k] === undefined)) return null
  return { http: def.http, body }
}

// Ruta interna del logo de una revisión (formato fijado por la migración 1/4: quotes/{quote}/revisions/{revision}.logo). Debe
// coincidir con la revisión de la MISMA respuesta; cualquier otra cosa (URL, otra carpeta, otra revisión) se rechaza.
export function validateLogoPath(path, revision) {
  if (typeof path !== 'string' || typeof revision !== 'string' || !UUID_RE.test(revision)) return null
  const m = /^quotes\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/revisions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.logo$/.exec(path)
  return m && m[2] === revision.toLowerCase() ? path : null
}

// Tipo real por firma (nunca por la cabecera de Storage). Solo PNG y JPEG; SVG y todo lo demás se rechazan.
export function sniffLogo(bytes) {
  if (!bytes || bytes.length < 12 || bytes.length > MAX_LOGO_BYTES) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return null
}

// ---------------------------------------------------------------------------
// Registro: lista blanca de campos. Jamás tokens, nombres, cuerpos, cabeceras ni mensajes crudos.
// ---------------------------------------------------------------------------
const LOG_FIELDS = ['outcome', 'http', 'rpcCode', 'ms']
export function logPublic(event, info) {
  const safe = { event: String(event).slice(0, 20) }
  for (const k of LOG_FIELDS) if (info && info[k] !== undefined) safe[k] = typeof info[k] === 'string' ? info[k].slice(0, 40) : info[k]
  console.error('[api/public]', JSON.stringify(safe))
}
