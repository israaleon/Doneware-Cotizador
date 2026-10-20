// lib/quotePdfStorage.js
// Fase 6.5 — PDF histórico persistido de una cotización. Primitivas pequeñas
// sobre Storage, igual que lib/quoteLogo.js: no genera contenido PDF, no
// decide cuándo llamarse — esa orquestación vive en lib/pdf.js (que sí
// conoce buildPdfDoc) y en las páginas que la usan.
import { supabase } from './supabaseClient'
import { listDirNames, removeVerified } from './storageVerifiedRemove'
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
// precontractual YA CONFIRMADA (app/historial/page.js llama a esto solo tras el
// DELETE confirmado de la fila). No se usa para limpiar revisiones de
// cotizaciones que siguen existiendo: la política de Storage (migración 2) lo
// impediría. El resultado se VERIFICA por rutas: `ok` solo si, listando, no
// queda ninguna (remove() responde éxito con lista vacía cuando la política bloquea).
export async function removeQuoteRevisionFiles(quoteId) {
  if (!quoteId) return { ok: false, status: 'invalid_input', requested: [], removed: [], remaining: [], absent: [], error: 'sin quoteId' }
  const prefix = `quotes/${quoteId}/revisions`
  const { names, folders, error } = await listDirNames(prefix, { bucket: BUCKET })
  if (!names) return { ok: false, status: 'list_error', requested: [], removed: [], remaining: [], absent: [], unverified: [], rejected: [], error: error && error.message ? error.message : String(error) }
  // Solo se borran archivos DIRECTOS de esta carpeta (prefijo autorizado); una subcarpeta inesperada no se recorre y deja la limpieza sin verificar.
  const res = await removeVerified([...names].map((n) => `${prefix}/${n}`), { bucket: BUCKET, allowedPrefix: `${prefix}/` })
  // Una subcarpeta (contenido que no se recorre) deja SIEMPRE la limpieza sin verificar por completo, aunque lo demás haya salido parcial o bien.
  if (folders && folders.size) return { ...res, ok: false, status: res.ok ? 'has_subfolders' : res.status, unverified: [...(res.unverified || []), ...[...folders].map((f) => `${prefix}/${f}/`)] }
  return res
}

// Descarga el PDF histórico persistido. Devuelve un Blob o null (nunca
// lanza) — el llamador decide el fallback.
export async function downloadPersistedPdf(path) {
  if (!path) return null
  const { data, error } = await supabase.storage.from(BUCKET).download(path)
  if (error || !data) return null
  return data
}
