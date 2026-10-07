// lib/quotePdfStorage.js
// Fase 6.5 — PDF histórico persistido de una cotización. Primitivas pequeñas
// sobre Storage, igual que lib/quoteLogo.js: no genera contenido PDF, no
// decide cuándo llamarse — esa orquestación vive en lib/pdf.js (que sí
// conoce buildPdfDoc) y en las páginas que la usan.
import { supabase } from './supabaseClient'
export { getRevisionPdfPath } from './quoteRevision'

const BUCKET = 'quote_documents'

// Ruta canónica, determinista: sin timestamp, sin folio, sin versión — la
// misma cotización siempre reutiliza exactamente esta ruta.
export function getQuotePdfPath(quoteId) {
  if (!quoteId) throw new Error('getQuotePdfPath requiere un quoteId')
  return `quotes/${quoteId}/quote.pdf`
}

// upsert:true — sobrescritura atómica de un solo objeto (nunca move/copy
// entre rutas): a diferencia del logo, los bytes del PDF ya están
// completamente generados y validados en memoria (el Blob) antes de esta
// llamada, así que no hace falta ninguna ruta temporal de por medio.
// cacheControl:'0' — mismo motivo verificado empíricamente en Fase 6.4B: el
// path se reutiliza en cada edición precontrato con bytes nuevos.
export async function uploadQuotePdf(path, blob) {
  const { error } = await supabase.storage.from(BUCKET)
    .upload(path, blob, { contentType: 'application/pdf', upsert: true, cacheControl: '0' })
  if (error) return { ok: false, error }
  return { ok: true }
}

// Fase 6.7C-1 — sube una REVISIÓN publicada a su ruta inmutable
// (getRevisionPdfPath). upsert:false: si el objeto ya existiera, Storage
// responde error y NO se reemplaza nada — una revisión nunca se sobrescribe.
// Nunca se usa con la ruta canónica quote.pdf.
export async function uploadRevisionPdf(path, blob) {
  const { error } = await supabase.storage.from(BUCKET)
    .upload(path, blob, { contentType: 'application/pdf', upsert: false, cacheControl: '0' })
  if (error) return { ok: false, error }
  return { ok: true }
}

// Fase 6.7C-1 — elimina TODO lo que cuelga de quotes/{id}/revisions/ (PDFs y
// logos de revisión). Exclusivo de la eliminación física de una cotización
// precontractual (app/historial/page.js ya valida canDeleteQuote antes de
// llamarla). No se usa para limpiar revisiones de cotizaciones que siguen
// existiendo.
export async function removeQuoteRevisionFiles(quoteId) {
  if (!quoteId) return { ok: false }
  const prefix = `quotes/${quoteId}/revisions`
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 })
  if (error) return { ok: false, error }
  const paths = (data || []).filter((o) => o && o.name).map((o) => `${prefix}/${o.name}`)
  if (!paths.length) return { ok: true }
  const { error: rmError } = await supabase.storage.from(BUCKET).remove(paths)
  if (rmError) return { ok: false, error: rmError }
  return { ok: true }
}

// Descarga el PDF histórico persistido. Devuelve un Blob o null (nunca
// lanza) — el llamador decide el fallback.
export async function downloadPersistedPdf(path) {
  if (!path) return null
  const { data, error } = await supabase.storage.from(BUCKET).download(path)
  if (error || !data) return null
  return data
}
