// lib/publicQuoteView.js — lógica PURA de la página pública /q/[token] (sin React, sin red, sin variables de entorno).
// Fase 6.7 / bloque 6. Contratos de referencia: CONTRATOS-HTTP-api-publica.md (§2 GET, §3 accept) y CONTRATOS-aceptacion-publica.md.
//
// La página NO repite reglas de negocio del servidor (vigencia, estado, revisión, nombre, cupos): solo traduce las respuestas de la
// API a vistas, normaliza lo que va a mostrar (lista blanca, tipos, longitudes) y decide qué se habilita en pantalla.
// Nunca se muestran ni se registran el token, el nonce o el nombre declarado fuera del estado en memoria de la página.

export const CONSENT_VERSION = 1
// Texto exacto aprobado para consent_version = 1 (CONTRATOS-aceptacion-publica §6). SHA-256 (UTF-8): 45f14d91dd65383986f0f1f0345f137e7dd5f330e7296a44de369baca6604786
// lib/publicAcceptance.js es solo de servidor ('server-only'), por eso el texto se repite aquí; una prueba compara ambos y el hash.
export const CONSENT_TEXT_V1 = 'He revisado esta versión de la cotización y acepto sus conceptos, importes y condiciones.'
export const STALE_LINK_NOTICE = 'Este enlace corresponde a una versión anterior. Revisa la versión vigente antes de aceptarla.'
export const REVIEWED_TEXT = 'He revisado la versión vigente'

export const GET_TIMEOUT_MS = 15000
export const ACCEPT_TIMEOUT_MS = 20000
export const MAX_RETRY_AFTER_S = 120
export const MIN_RETRY_AFTER_S = 1
export const ERROR_COOLDOWN_S = 3
// Tras un resultado no confirmado se consulta el estado (GET) como máximo estas veces, con estas esperas; nunca se reenvía accept.
export const UNKNOWN_CHECK_DELAYS_MS = [2000, 5000, 10000]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX8_RE = /^[0-9a-f]{8}$/i
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const MAX = {
  name: 300, unit: 40, short: 60, company: 200, contact: 200, address: 400, website: 200,
  terms: 20000, notes: 6000, items: 200, person: 200, revisionName: 120,
}

// ---------------------------------------------------------------------------
// Texto seguro: la página solo pinta texto (React lo escapa); además se quitan caracteres de control, invisibles y de
// reordenamiento bidireccional que servirían para suplantar o romper el diseño, y se acota la longitud.
// ---------------------------------------------------------------------------
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
const INVISIBLE_RE = new RegExp("[\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]", "g")

export function sanitizeText(value, max, { multiline = false } = {}) {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  let s = String(value)
  s = s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
  s = s.replace(CONTROL_RE, '').replace(INVISIBLE_RE, '')
  if (!multiline) s = s.replace(/\n+/g, ' ')
  s = multiline ? s.replace(/\n{3,}/g, '\n\n').trim() : s.replace(/\s+/g, ' ').trim()
  return Array.from(s).slice(0, max).join('')
}

export function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null }
  return null
}

const MONEY = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })
export function formatMoney(v) { const n = toNum(v); return n === null ? '—' : MONEY.format(n) }

const QTY = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 3 })
export function formatQty(v) { const n = toNum(v); return n === null ? '—' : QTY.format(n) }

const DATE_ONLY = new Intl.DateTimeFormat('es-MX', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
const DATE_TIME = new Intl.DateTimeFormat('es-MX', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Mexico_City' })

// Fechas solo-día del contrato (YYYY-MM-DD): se formatean en UTC para que la zona horaria del visitante no las corra un día.
export function formatDate(v) {
  if (typeof v !== 'string') return ''
  const m = DATE_RE.exec(v.slice(0, 10))
  if (!m) return ''
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3]) ? '' : DATE_ONLY.format(d)
}
export function formatDateTime(v) {
  if (typeof v !== 'string') return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : DATE_TIME.format(d)
}

// ---------------------------------------------------------------------------
// Documento (lista blanca de la API, §2.2): cada campo es opcional para la página; lo que falte se omite o se muestra «—».
// ---------------------------------------------------------------------------
export function normalizeDoc(d) {
  const doc = d && typeof d === 'object' ? d : {}
  const company = doc.company && typeof doc.company === 'object' ? doc.company : {}
  const client = doc.client && typeof doc.client === 'object' ? doc.client : {}
  const rawItems = Array.isArray(doc.items) ? doc.items.slice(0, MAX.items) : []
  const items = rawItems.filter((i) => i && typeof i === 'object').map((i) => ({
    name: sanitizeText(i.name, MAX.name) || 'Concepto',
    unit: sanitizeText(i.unit, MAX.unit),
    qty: toNum(i.qty),
    price: toNum(i.price),
    subtotal: toNum(i.subtotal),
  }))
  const dt = typeof doc.discount_type === 'string' ? doc.discount_type : ''
  return {
    folio: sanitizeText(doc.folio, MAX.short),
    createdAt: typeof doc.created_at === 'string' ? doc.created_at : '',
    company: {
      name: sanitizeText(company.company_name, MAX.company),
      phone: sanitizeText(company.phone, MAX.short),
      email: sanitizeText(company.email, MAX.contact),
      address: sanitizeText(company.address, MAX.address),
      website: sanitizeText(company.website, MAX.website),
      terms: sanitizeText(company.terms, MAX.terms, { multiline: true }),
    },
    clientName: sanitizeText(client.name, MAX.person),
    items,
    discountType: dt === 'percent' || dt === 'fixed' ? dt : '',
    discountValue: toNum(doc.discount_value),
    discount: toNum(doc.discount),
    subtotal: toNum(doc.subtotal),
    ivaRate: toNum(doc.iva_rate),
    applyIva: doc.apply_iva === true,
    iva: toNum(doc.iva),
    total: toNum(doc.total),
    installTimeValue: toNum(doc.install_time_value),
    installTimeUnit: sanitizeText(doc.install_time_unit, MAX.short),
    notes: sanitizeText(doc.notes, MAX.notes, { multiline: true }),
    quoteType: typeof doc.quote_type === 'string' ? doc.quote_type : '',
    requiresService: doc.requires_service === true,
    serviceAddress: doc.requires_service === true ? sanitizeText(doc.service_address, MAX.address) : '',
  }
}

// ---------------------------------------------------------------------------
// GET /api/public/quotes/{token} → vista. Nunca se muestra como «abierta» algo que el contrato no garantice.
// ---------------------------------------------------------------------------
export function clampRetryAfter(v) {
  const n = toNum(v)
  if (n === null) return 10
  return Math.min(MAX_RETRY_AFTER_S, Math.max(MIN_RETRY_AFTER_S, Math.ceil(n)))
}

const INFO_ONLY_STATES = new Set(['unpublished', 'unavailable', 'contracted', 'cancelled'])

export function normalizeQuote(res) {
  if (!res || res.ok !== true) return { kind: 'error' }
  const { status, body } = res
  if (status === 429) return { kind: 'ratelimited', retryAfter: clampRetryAfter(body && body.retry_after) }
  if (status === 404) return { kind: 'invalid' }
  if (status !== 200 || !body || typeof body !== 'object' || typeof body.state !== 'string') return { kind: 'error' }
  const base = { folio: sanitizeText(body.folio, MAX.short), companyName: sanitizeText(body.company_name, MAX.company) }
  const st = body.state
  if (st === 'invalid') return { kind: 'invalid' }
  if (INFO_ONLY_STATES.has(st)) return { kind: st, ...base }
  if (st === 'expired') return { kind: 'expired', ...base, validUntil: typeof body.valid_until === 'string' ? body.valid_until : '' }
  if (st === 'accepted') {
    return {
      kind: 'accepted', ...base,
      acceptedAt: typeof body.accepted_at === 'string' ? body.accepted_at : '',
      acceptedByName: sanitizeText(body.accepted_by_name, MAX.revisionName),
      revisionCode: typeof body.revision_code === 'string' && HEX8_RE.test(body.revision_code) ? body.revision_code.toLowerCase() : '',
      doc: body.doc && typeof body.doc === 'object' ? normalizeDoc(body.doc) : null,
    }
  }
  if (st === 'open') {
    const revisionOk = typeof body.revision === 'string' && UUID_RE.test(body.revision)
    const codeOk = typeof body.revision_code === 'string' && HEX8_RE.test(body.revision_code)
    const nonceOk = typeof body.nonce === 'string' && body.nonce.length > 0 && body.nonce.length <= 512
    if (!revisionOk || !codeOk || !nonceOk || !body.doc || typeof body.doc !== 'object') return { kind: 'error' }
    return {
      kind: 'open',
      revision: body.revision.toLowerCase(),
      revisionCode: body.revision_code.toLowerCase(),
      nonce: body.nonce,
      consentVersion: toNum(body.consent_version),
      validUntil: typeof body.valid_until === 'string' ? body.valid_until : '',
      publishedAt: typeof body.published_at === 'string' ? body.published_at : '',
      logo: body.logo === true,
      doc: normalizeDoc(body.doc),
    }
  }
  return { kind: 'error' }
}

// ---------------------------------------------------------------------------
// POST …/accept → resultado. Cualquier respuesta que no sea un «accepted»/«already_accepted» bien formado NUNCA es éxito.
// ---------------------------------------------------------------------------
const TERMINAL = new Set(['expired', 'cancelled', 'contracted', 'unpublished', 'unavailable', 'invalid'])

export function normalizeAccept(res) {
  // Red caída, tiempo agotado o respuesta cortada: el resultado es desconocido (la transacción pudo terminar).
  if (!res || res.ok !== true) return { kind: 'unknown' }
  const { status, body } = res
  const b = body && typeof body === 'object' ? body : null
  const code = b && typeof b.status === 'string' ? b.status : (b && typeof b.error === 'string' ? b.error : '')
  if (status === 429) return { kind: 'ratelimited', retryAfter: clampRetryAfter(b && b.retry_after) }
  if (status === 200 && b && b.status === 'accepted') {
    return { kind: 'accepted', acceptedAt: typeof b.accepted_at === 'string' ? b.accepted_at : '', revisionCode: typeof b.revision_code === 'string' && HEX8_RE.test(b.revision_code) ? b.revision_code.toLowerCase() : '' }
  }
  if (status === 200 && b && b.status === 'already_accepted') {
    return {
      kind: 'already',
      acceptedAt: typeof b.accepted_at === 'string' ? b.accepted_at : '',
      revisionCode: typeof b.revision_code === 'string' && HEX8_RE.test(b.revision_code) ? b.revision_code.toLowerCase() : '',
      // Solo «true» explícito cuenta como «la versión mostrada es la aceptada»; cualquier otra cosa se trata como que NO lo es.
      matches: b.requested_revision_matches === true,
    }
  }
  if (status === 409 && b && b.status === 'quote_changed') return { kind: 'quote_changed' }
  if (status === 400 && b && b.status === 'invalid_input') return { kind: 'invalid_input', field: typeof b.field === 'string' ? b.field : '' }
  if (status === 403 && (code === 'nonce_invalid' || code === 'nonce_expired')) return { kind: 'nonce', expired: code === 'nonce_expired' }
  if (status === 403) return { kind: 'forbidden' }
  if (status === 503 && b && b.error === 'result_unknown') return { kind: 'unknown' }
  if (status === 503 && b && (b.error === 'temporarily_unavailable' || b.error === 'service_unavailable')) return { kind: 'rollback' }
  if ((status === 404 || status === 409 || status === 410) && TERMINAL.has(code)) return { kind: 'terminal', status: code }
  // Una respuesta 2xx que no se puede leer o no se reconoce (cuerpo cortado, formato inesperado) NO prueba que no se aceptó:
  // la transacción pudo terminar. Lo mismo para cualquier 5xx. Nunca se muestra como éxito ni como fallo: se consulta el estado.
  if (status === 200 || status >= 500) return { kind: 'unknown' }
  return { kind: 'error' }
}

// ---------------------------------------------------------------------------
// Reglas de pantalla (no de negocio): enlace antiguo, banderas ligadas a la revisión y habilitación del botón.
// ---------------------------------------------------------------------------
// ?v= es solo una pista de experiencia: cualquier valor presente que no sea el código de la revisión vigente se trata como antiguo.
export function isStaleHint(hint, revisionCode) {
  if (typeof hint !== 'string') return false
  const h = hint.trim().toLowerCase()
  if (h === '') return false
  return h !== String(revisionCode || '').toLowerCase()
}

// Una casilla solo vale para la revisión con la que se marcó: al cambiar la revisión se reinicia sola.
export function flagActive(flag, revision) {
  return !!flag && flag.value === true && typeof revision === 'string' && flag.revision === revision
}

export function canSubmit({ view, name, consent, reviewed, needsReview, busy }) {
  if (!view || view.kind !== 'open') return false
  if (busy) return false
  if (view.consentVersion !== CONSENT_VERSION) return false
  if (typeof name !== 'string' || sanitizeText(name, 400) === '') return false
  if (!flagActive(consent, view.revision)) return false
  if (needsReview && !flagActive(reviewed, view.revision)) return false
  return true
}

// Mensajes (sin detalles técnicos, sin eco de datos del visitante).
export function fieldMessage(field) {
  switch (field) {
    case 'name': return 'Revisa tu nombre: debe tener entre 2 y 120 caracteres, sin caracteres especiales.'
    case 'consent':
    case 'consent_version': return 'Marca la casilla de conformidad para continuar.'
    case 'revision':
    case 'nonce':
    case 'body': return 'No pudimos validar el formulario. Actualiza la página e inténtalo de nuevo.'
    default: return 'Revisa los datos e inténtalo de nuevo.'
  }
}
