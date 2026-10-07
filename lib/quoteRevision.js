// lib/quoteRevision.js
// Fase 6.7C-1 — piezas PURAS (sin imports, sin Supabase, sin DOM) de la
// publicación de revisiones: rutas inmutables, vencimiento candidato y
// published_snapshot. Aisladas aquí para poder probarse directamente.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Solo minúsculas: PostgreSQL devuelve uuid::text en minúsculas y
// contract_quote compara la ruta de la fila con un texto reconstruido de
// forma exacta, así que cualquier otra forma nunca coincidiría.
function assertUuid(value, name) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`${name} debe ser un uuid en minúsculas`)
  }
}

// Ruta ÚNICA e inmutable de una revisión publicada. Nunca se reutiliza.
export function getRevisionPdfPath(quoteId, revisionId) {
  assertUuid(quoteId, 'quoteId')
  assertUuid(revisionId, 'revisionId')
  return `quotes/${quoteId}/revisions/${revisionId}.pdf`
}

// Copia del logo que acompaña a ESA revisión (misma inmutabilidad).
export function getRevisionLogoPath(quoteId, revisionId) {
  assertUuid(quoteId, 'quoteId')
  assertUuid(revisionId, 'revisionId')
  return `quotes/${quoteId}/revisions/${revisionId}.logo`
}

// ---------- Vencimiento candidato (solo para RENDERIZAR) ----------
// Replica la semántica del trigger set_quote_valid_until de PostgreSQL:
//   (timezone('America/Mexico_City', created_at))::date + valid_days
// La autoridad contractual sigue siendo quotes.valid_until (DB); esto solo
// produce el valor que se imprime en el PDF candidato, y la publicación
// verifica después que la DB devolvió exactamente el mismo.
const MX_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit',
})

// 'YYYY-MM-DD' del día calendario de Ciudad de México que corresponde a un
// instante, o null si no es una fecha válida.
export function mexicoCityDate(instant) {
  const d = new Date(instant)
  if (Number.isNaN(d.getTime())) return null
  const parts = Object.fromEntries(MX_DATE.formatToParts(d).map((p) => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

// created_at (instante, ISO) + valid_days (entero) -> 'YYYY-MM-DD' o null.
// null significa "no calculable" (igual que el trigger cuando falta alguno).
export function computeValidUntilMX(createdAt, validDays) {
  if (createdAt == null || createdAt === '' || validDays == null || validDays === '') return null
  const n = Number(validDays)
  if (!Number.isInteger(n)) return null
  const base = mexicoCityDate(createdAt)
  if (!base) return null
  const [y, m, d] = base.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

// 'YYYY-MM-DD' -> texto es-MX (d/M/yyyy) SIN depender de la zona horaria del
// navegador (un `new Date('YYYY-MM-DD')` se interpreta en UTC y se vería un
// día antes en zonas al oeste de UTC).
export function formatValidUntilForPdf(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '')
  if (!m) return null
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString('es-MX', { timeZone: 'UTC' })
}

// ---------- published_snapshot ----------
// El snapshot es EXACTAMENTE el conjunto de campos de una fila de `quotes`
// que lib/pdfModel.js (resolveDocumentModel) consume para dibujar el PDF,
// más discount_type/discount_value (contractuales, no se dibujan) y
// valid_until. No se inventó estructura: es la misma forma que
// buildPdfDoc ya lee de un `rec`, así que buildPdfDoc(snapshot) reproduce
// el documento sin tocar ninguna fila viva.
export const PUBLISHED_SNAPSHOT_VERSION = 1

export const PUBLISHED_SNAPSHOT_FIELDS = [
  // identidad / documento
  'status', 'folio', 'related_folio', 'created_at',
  // vigencia
  'valid_days', 'valid_until',
  // cliente (resolveClient: snapshot moderno + columnas planas de respaldo)
  'client_snapshot', 'client_name', 'client_phone', 'client_email', 'client_address',
  // empresa (términos y datos de pago ya resueltos dentro de company_snapshot)
  'company_snapshot',
  // contenido económico
  'items', 'discount_type', 'discount_value', 'subtotal', 'discount',
  'iva', 'iva_rate', 'apply_iva', 'total',
  // contenido descriptivo
  'install_time_value', 'install_time_unit', 'notes',
  // tipo y servicio
  'quote_type', 'requires_service', 'service_address',
]

// `doc` = objeto con forma de fila de quotes (candidato). Devuelve una copia
// JSON profunda y desacoplada: ni muta `doc` ni queda referenciada por él.
export function buildPublishedSnapshot(doc) {
  const snap = { snapshot_version: PUBLISHED_SNAPSHOT_VERSION }
  for (const key of PUBLISHED_SNAPSHOT_FIELDS) snap[key] = doc[key] === undefined ? null : doc[key]
  return JSON.parse(JSON.stringify(snap))
}
