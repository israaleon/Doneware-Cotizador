// lib/linkManagement.js
// P-TOKEN (aplicación) — gestión del enlace de aceptación: revocar, regenerar, estado por versión y registro de la generación que
// contiene cada PDF. Todo pasa por las RPC de ptoken-01 (estado B: cerradas; estado C: habilitadas por ptoken-02). Sin React.
//
// Principios:
//  • `rpc` se INYECTA ((nombre, args) => Promise<{ data, error }>), por defecto supabase.rpc: así se prueba con simulaciones y con el laboratorio SQL.
//  • Una operación = UN intento. Nunca se repite ni se deshace sola. Si el resultado es incierto (respuesta perdida, 5xx, cuerpo inesperado) se
//    dice así y quien llama consulta el estado real; jamás se afirma lo que la base no confirmó.
//  • «Función no habilitada» solo se concluye de un 42501 cuyo mensaje nombra ESA función (o de PGRST202 sobre ella). Cualquier otro 42501 es
//    un error visible (kind 'forbidden'), no se oculta.
//  • Nada de tokens ni enlaces en mensajes ni en resultados: el token solo se pasa como argumento a record_revision_link.
import { supabase } from './supabaseClient'

export const defaultRpc = (name, args) => supabase.rpc(name, args)

export const FN = {
  status: 'quote_revision_link_status',
  revoke: 'revoke_quote_acceptance_token',
  regenerate: 'regenerate_quote_link',                 // ptoken-03: regeneración IDEMPOTENTE por identidad de acción
  requestStatus: 'quote_link_request_status',          // ptoken-03: recuperar (solo lectura) el resultado de una acción por su identidad
  record: 'record_revision_link',
}

// Lista cerrada de motivos (D-T4); coincide con la validación de la base.
export const REASONS = [
  { value: 'leaked', label: 'El enlace se filtró o se compartió por error' },
  { value: 'wrong_recipient', label: 'Se envió a la persona equivocada' },
  { value: 'resend', label: 'Se reemplaza por un enlace nuevo' },
  { value: 'other', label: 'Otro motivo' },
]
export const NOTE_MAX = 200
// Caracteres no admitidos en la nota (control e invisibles); se comprueba por punto de código para no depender de secuencias de escape.
const BAD_RANGES = [[0x01, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff]]
const hasBadChar = (str) => { for (const ch of str) { const c = ch.codePointAt(0); if (BAD_RANGES.some(([a, b]) => c >= a && c <= b)) return true } return false }
const SPACES = new RegExp('[ ' + String.fromCharCode(0xa0) + ']+', 'g')

// ¿Esta fila puede tener enlace gestionable? Cotización moderna y publicada (cualquier estado contractual: revocar también aplica a las aceptadas).
export function canManageLink(rec) {
  return !!rec && rec.status === 'cotizacion' && !!rec.company_snapshot && !!rec.content_revision
}
export function canRegenerateLink(rec) {
  return canManageLink(rec) && rec.lifecycle_status === 'cotizacion'
}

// Nota opcional, solo interna y breve: se normaliza igual que la base (espacios/NBSP colapsados, recorte) y no admite caracteres de control ni datos largos.
export function validateNote(raw) {
  if (raw == null) return { ok: true, value: null }
  const v = String(raw).replace(SPACES, ' ').trim()
  if (!v) return { ok: true, value: null }
  if (v.length > NOTE_MAX) return { ok: false, message: `La nota admite como máximo ${NOTE_MAX} caracteres.` }
  if (hasBadChar(v)) return { ok: false, message: 'La nota no puede contener caracteres de control.' }
  return { ok: true, value: v }
}
export function validateReason(value) {
  return REASONS.some((r) => r.value === value)
}

const DOMAIN_MESSAGES = {
  AQ001: 'La sesión expiró; vuelve a iniciar sesión.',
  AQ002: 'La cotización ya no existe.',
  AQ003: 'La cotización ya no es precontractual: su enlace solo puede revocarse, no regenerarse.',
  AQ004: 'La cotización es anterior al modelo actual (sin snapshot de empresa); no admite enlace de aceptación.',
  AQ005: 'La cotización no tiene vigencia.',
  AQ006: 'El enlace de aceptación de esta cotización fue revocado; no se regenera automáticamente.',
  AQ007: 'Motivo inválido.',
  AQ008: 'Nota inválida (máximo 200 caracteres, sin caracteres de control).',
  AQ009: 'La cotización no tiene enlace de aceptación todavía (se crea al publicar).',
  AQ012: 'El enlace indicado no pertenece a esta cotización.',
  AQ013: 'Esa versión no existe en el historial de la cotización.',
  AQ014: 'Esa versión ya tiene registrada otra generación de enlace; no se sobrescribe.',
  AQ015: 'Falta la identidad de la acción.',
  AQ016: 'Esa identidad de acción ya se usó con otros parámetros; inicia la acción de nuevo.',
}
export const domainMessage = (code) => DOMAIN_MESSAGES[code] || 'La base de datos rechazó la solicitud (' + code + ').'

// Clasificación de un error de RPC. `fn` es la función llamada.
//   not_enabled → la función existe/no existe pero NO está disponible para esta sesión (42501 nombrando esa función, o PGRST202 sobre ella)
//   forbidden   → cualquier OTRO 42501: inesperado, se muestra (no se oculta como «no habilitada»)
//   domain      → AQxxx: rechazo definitivo de la regla de negocio (sin efecto)
//   unknown     → lo demás (red, 5xx, sin código): el resultado de una ESCRITURA es incierto
export function classifyError(error, fn) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  const msg = error && typeof error.message === 'string' ? error.message : ''
  const named = new RegExp('\\b' + fn + '\\b').test(msg)
  if (code === '42501') {
    if (named && /permission denied for function/i.test(msg)) return { kind: 'not_enabled', code }
    return { kind: 'forbidden', code }
  }
  if (code === 'PGRST202' && named) return { kind: 'not_enabled', code }
  if (/^AQ[0-9]{3}$/.test(code)) return { kind: 'domain', code }
  return { kind: 'unknown', code: /^[A-Za-z0-9_]{1,12}$/.test(code) ? code : '' }
}

async function callRpc(rpc, fn, args) {
  let res
  try {
    res = await rpc(fn, args)
  } catch {
    return { ok: false, kind: 'unknown', code: '' }
  }
  if (!res || typeof res !== 'object') return { ok: false, kind: 'unknown', code: '' }
  if (res.error) return { ok: false, ...classifyError(res.error, fn) }
  return { ok: true, data: res.data }
}

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x)

function normalizeStatus(data) {
  if (!isObj(data) || !Array.isArray(data.revisions)) return null
  const ag = data.active_generation
  if (!(ag === null || ag === undefined || (Number.isInteger(ag) && ag >= 1))) return null
  const revisions = []
  for (const r of data.revisions) {
    if (!isObj(r) || typeof r.revision_code !== 'string' || !/^[0-9a-f]{8}$/.test(r.revision_code)) return null
    if (r.link !== 'recorded' && r.link !== 'unknown') return null
    if (r.link === 'recorded' && !(Number.isInteger(r.generation) && r.generation >= 1 && (r.token_status === 'active' || r.token_status === 'revoked'))) return null
    revisions.push({ revision_code: r.revision_code, published_at: typeof r.published_at === 'string' ? r.published_at : null, link: r.link,
      generation: r.link === 'recorded' ? r.generation : null, token_status: r.link === 'recorded' ? r.token_status : null })
  }
  return { active_generation: ag ?? null, revisions }
}

// Estado del enlace de una cotización: generación activa y, por cada versión publicada, qué generación contiene su PDF o «unknown».
export async function getLinkStatus(rpc, quoteId) {
  if (!quoteId) return { ok: false, kind: 'invalid_input', code: '' }
  const r = await callRpc(rpc, FN.status, { p_quote_id: quoteId })
  if (!r.ok) return r
  const s = normalizeStatus(r.data)
  if (!s) return { ok: false, kind: 'malformed', code: '' }
  return { ok: true, ...s }
}

// ¿Están habilitadas las operaciones? Se decide con una llamada de SOLO LECTURA (estado) sobre una cotización real: si la función se ejecuta (aunque
// responda «no existe») está habilitada. Se vuelve a evaluar cada vez que se pide: la habilitación posterior (ptoken-02) no exige cambios de código.
//   enabled | unavailable (función no disponible para esta sesión) | error (cualquier otra cosa: 42501 inesperado, red, sesión…)
export async function detectLinkCapability(rpc, probeQuoteId) {
  if (!probeQuoteId) return { state: 'unknown' }
  const r = await getLinkStatus(rpc, probeQuoteId)
  if (r.ok) return { state: 'enabled' }
  if (r.kind === 'not_enabled') return { state: 'unavailable' }
  if (r.kind === 'domain' && r.code === 'AQ002') return { state: 'enabled' }    // la función se ejecutó; la cotización de prueba ya no existe
  return { state: 'error', kind: r.kind, code: r.code }
}

// Escrituras (revocar / regenerar): UN intento. Resultado: { ok:true, ... } | { ok:false, kind:'domain'|'not_enabled'|'forbidden'|'invalid_input' } (sin efecto)
// | { ok:false, kind:'unknown_result' } (puede haberse aplicado: consultar el estado, no repetir).
async function write(rpc, fn, args, validate) {
  const r = await callRpc(rpc, fn, args)
  if (!r.ok) {
    if (r.kind === 'unknown' || r.kind === 'malformed') return { ok: false, kind: 'unknown_result', code: r.code || '' }
    return r
  }
  const v = validate(r.data)
  if (!v) return { ok: false, kind: 'unknown_result', code: '' }
  return { ok: true, ...v }
}
function prep(quoteId, reason, note) {
  if (!quoteId) return { fail: { ok: false, kind: 'invalid_input', message: 'Falta la cotización.' } }
  if (!validateReason(reason)) return { fail: { ok: false, kind: 'invalid_input', message: 'Elige un motivo de la lista.' } }
  const n = validateNote(note)
  if (!n.ok) return { fail: { ok: false, kind: 'invalid_input', message: n.message } }
  return { args: { p_quote_id: quoteId, p_reason: reason, p_note: n.value } }
}
export async function revokeLink(rpc, { quoteId, reason, note }) {
  const p = prep(quoteId, reason, note)
  if (p.fail) return p.fail
  return write(rpc, FN.revoke, p.args, (d) => {
    if (!isObj(d) || (d.status !== 'revoked' && d.status !== 'already_revoked')) return null
    return { status: d.status, generation: Number.isInteger(d.generation) ? d.generation : null, acceptedBefore: d.accepted_before_revocation === true }
  })
}
// Identidad de UNA acción explícita de regenerar: se crea cuando la persona inicia la acción y se conserva en doble clic, resultado incierto y «Reintentar esta acción».
// La misma identidad nunca crea otra generación (la base devuelve el resultado ya aplicado, replayed = true); una acción nueva usa una identidad nueva.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export function newRequestId() {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') return null
  return crypto.randomUUID()
}
const regenResult = (d) => {
  if (!isObj(d) || d.status !== 'regenerated' || !Number.isInteger(d.generation) || d.generation < 1) return null
  return { status: 'regenerated', generation: d.generation, previousRevoked: d.previous_generation_revoked === true, replayed: d.replayed === true }
}
export async function regenerateLink(rpc, { quoteId, requestId, reason, note }) {
  const p = prep(quoteId, reason, note)
  if (p.fail) return p.fail
  if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) return { ok: false, kind: 'invalid_input', message: 'Falta la identidad de la acción de regenerar.' }
  return write(rpc, FN.regenerate, { p_quote_id: quoteId, p_request_id: requestId, p_reason: reason, p_note: p.args.p_note }, regenResult)
}
// Recuperar el resultado de una acción de regenerar tras una respuesta perdida: SOLO LECTURA (nunca genera).
//   { ok:true, found:true, ... } la acción SÍ se aplicó (mismo resultado que habría devuelto) · { ok:true, found:false } el servidor no tiene registro (no se aplicó, o aún está en curso)
//   { ok:false, kind } no se pudo consultar (not_enabled | forbidden | domain | unknown)
export async function getRegenerateResult(rpc, { requestId, quoteId }) {
  if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) return { ok: false, kind: 'invalid_input', code: '' }
  const r = await callRpc(rpc, FN.requestStatus, { p_request_id: requestId })
  if (!r.ok) return r
  const d = r.data
  if (!isObj(d) || typeof d.found !== 'boolean') return { ok: false, kind: 'malformed', code: '' }
  if (!d.found) return { ok: true, found: false }
  if (d.action !== 'regenerate' || (quoteId && d.quote_id !== quoteId)) return { ok: false, kind: 'malformed', code: '' }
  const v = regenResult(d.result)
  if (!v) return { ok: false, kind: 'malformed', code: '' }
  return { ok: true, found: true, ...v }
}

// Registro de la generación que contiene el PDF de una versión: se identifica por el TEXTO del token que se incrustó (no por «la generación activa
// al terminar»): si el enlace se revocó o regeneró durante la publicación, la respuesta lo dice (tokenStatus 'revoked') y no se atribuye a otra.
// UN intento, sin reintentos. state: recorded | already_recorded | not_enabled | forbidden | rejected | unknown_result | malformed
export async function recordRevisionLink(rpc, { quoteId, revision, token }) {
  if (!quoteId || !revision || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return { state: 'rejected', code: 'invalid_input' }
  const r = await callRpc(rpc, FN.record, { p_quote_id: quoteId, p_revision: revision, p_token: token })
  if (!r.ok) {
    if (r.kind === 'not_enabled') return { state: 'not_enabled' }
    if (r.kind === 'forbidden') return { state: 'forbidden', code: r.code }
    if (r.kind === 'domain') return { state: 'rejected', code: r.code }
    return { state: 'unknown_result' }
  }
  const d = r.data
  if (!isObj(d) || (d.status !== 'recorded' && d.status !== 'already_recorded') || !Number.isInteger(d.generation) || d.generation < 1
      || (d.token_status !== 'active' && d.token_status !== 'revoked')) return { state: 'malformed' }
  return { state: d.status, generation: d.generation, tokenStatus: d.token_status }
}

// Texto para quien publica. warn=true → se añade a los avisos de la publicación. Nunca afirma «registrado» sin confirmación de la base.
export function describeLinkRecording(r) {
  const base = 'La publicación se completó y se conserva, pero '
  switch (r && r.state) {
    case 'recorded':
    case 'already_recorded':
      if (r.tokenStatus === 'revoked') {
        return { warn: true, text: `ATENCIÓN: el enlace que lleva el PDF de esta versión (generación ${r.generation}) ya fue revocado mientras se publicaba, así que ese PDF no funcionará. Se registró tal cual (generación ${r.generation}, revocada); no se atribuyó a otra. Regenera el enlace en «Gestionar enlace» y vuelve a publicar.` }
      }
      return { warn: false, text: `Se registró que el PDF de esta versión contiene el enlace de la generación ${r.generation}.` }
    case 'not_enabled':
      return { warn: true, text: base + 'NO se registró qué generación del enlace contiene este PDF (el registro aún no está habilitado en la base de datos). El enlace de este PDF queda sin verificar.' }
    case 'forbidden':
      return { warn: true, text: base + `NO se registró qué generación del enlace contiene este PDF: la base denegó el permiso de forma inesperada (código ${r.code || '42501'}). Avisa a quien administra el sistema.` }
    case 'rejected':
      return { warn: true, text: base + `NO se registró qué generación del enlace contiene este PDF (${domainMessage(r.code)})` }
    case 'unknown_result':
      return { warn: true, text: base + 'no se pudo confirmar si se registró qué generación del enlace contiene este PDF. No se reintentó automáticamente; revisa «Gestionar enlace».' }
    default:
      return { warn: true, text: base + 'la respuesta del registro fue inesperada, así que no se afirma que quedó registrada la generación del enlace de este PDF.' }
  }
}

// Estado del enlace del PDF de UNA versión frente a la generación activa.
//   current   → su PDF lleva el enlace vigente
//   no_active → su PDF lleva un enlace REVOCADO y no hay ningún enlace activo
//   outdated  → su PDF pertenece a una generación anterior (revocada); hoy vigente es otra
//   unknown   → no se sabe qué enlace contiene (publicada antes del registro, o no se pudo registrar)
export function classifyRevisionLink(rev, activeGeneration) {
  if (!rev || rev.link !== 'recorded') return { state: 'unknown', tone: 'neutral', text: 'Se desconoce qué enlace contiene este PDF (publicada antes del registro o sin registrar). No se deduce del enlace actual.' }
  if (rev.token_status === 'active' && rev.generation === activeGeneration) return { state: 'current', tone: 'ok', text: `Su PDF contiene el enlace vigente (generación ${rev.generation}).` }
  if (rev.token_status === 'revoked' && !activeGeneration) return { state: 'no_active', tone: 'bad', text: `Su PDF contiene un enlace REVOCADO (generación ${rev.generation}) y no hay enlace activo: ya no funciona.` }
  return { state: 'outdated', tone: 'warn', text: `Su PDF pertenece a la generación ${rev.generation}, que ya no es la vigente${activeGeneration ? ` (hoy: ${activeGeneration})` : ''}: ese enlace ya no funciona.` }
}

// Resumen para una fila del Historial: la versión VIGENTE de la cotización (content_revision) frente al estado del enlace.
export function summarizeCurrentRevision(status, contentRevision) {
  const code = typeof contentRevision === 'string' ? contentRevision.slice(0, 8) : ''
  const rev = status.revisions.find((r) => r.revision_code === code) || null
  return classifyRevisionLink(rev, status.active_generation)
}

// Estados de varias filas con concurrencia limitada (una llamada de solo lectura por fila). Un error de una fila no afecta a las demás.
export async function loadLinkStates(rpc, recs, { concurrency = 4 } = {}) {
  const out = {}
  const queue = recs.filter(canManageLink)
  let i = 0
  async function worker() {
    while (i < queue.length) {
      const rec = queue[i++]
      const s = await getLinkStatus(rpc, rec.id)
      out[rec.id] = s.ok ? { ok: true, ...summarizeCurrentRevision(s, rec.content_revision), active_generation: s.active_generation } : { ok: false, kind: s.kind, code: s.code }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  return out
}
