// lib/quoteLogo.js
// Fase 6.4B — logo histórico de una cotización. Primitivas pequeñas y claras
// sobre Storage; la orquestación (cuándo llamar cada una, en qué orden,
// respecto al guardado en `quotes`) vive en app/cotizar/page.js, no aquí.
// No genera PDF, no arma snapshots — solo Storage.
import { supabase } from './supabaseClient'

const BUCKET = 'quote_documents'
// MIME reconocidos — nunca se inventa un fallback. image/jpg (variante no
// estándar que a veces reportan navegadores/servidores) se normaliza a
// image/jpeg, que es el tipo MIME real.
const RECOGNIZED_MIME = { 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg' }

function normalizeMime(raw) {
  const key = String(raw || '').toLowerCase().split(';')[0].trim()
  return RECOGNIZED_MIME[key] || null
}

// Ruta canónica, determinista: sin extensión, sin timestamp, sin folio, sin
// versión — la misma cotización siempre reutiliza exactamente esta ruta.
export function getHistoricalLogoPath(quoteId) {
  if (!quoteId) throw new Error('getHistoricalLogoPath requiere un quoteId')
  return `quotes/${quoteId}/logo`
}

// Fase 6.7C-1 — logo que viaja con UNA revisión publicada. Re-exportado de
// quoteRevision.js (módulo puro) para no duplicar el formato de la ruta.
export { getRevisionLogoPath } from './quoteRevision'

// Ruta temporal de un intento de copia — única por intento (nunca se
// referencia desde ningún snapshot; es un detalle interno de la subida
// segura, se promueve o se descarta siempre en el mismo guardado).
export function getTempHistoricalLogoPath(quoteId) {
  if (!quoteId) throw new Error('getTempHistoricalLogoPath requiere un quoteId')
  return `quotes/${quoteId}/logo.pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Descarga el logo público vigente de Configuración y valida su MIME real
// (el de la respuesta, nunca inventado). No sube nada. Los bytes nunca se
// recomprimen ni se convierten.
export async function fetchCurrentLogo(logoUrl) {
  if (!logoUrl) return { ok: false, reason: 'sin-logo' }
  let res
  try {
    res = await fetch(logoUrl)
  } catch (e) {
    return { ok: false, reason: 'fetch-error', detail: e.message }
  }
  if (!res.ok) return { ok: false, reason: 'http-error', detail: res.status }
  const blob = await res.blob()
  const contentType = normalizeMime(blob.type || res.headers.get('content-type'))
  if (!contentType) return { ok: false, reason: 'mime-no-reconocido', detail: blob.type || res.headers.get('content-type') || '' }
  return { ok: true, blob, contentType }
}

export async function uploadToPath(path, blob, contentType) {
  // cacheControl:'0' — verificado empíricamente que sin esto Supabase Storage
  // sirve las descargas con `Cache-Control: public, max-age=3600`; como una
  // edición precontrato reutiliza la MISMA ruta canónica con bytes nuevos,
  // eso podría servir el logo viejo cacheado hasta por una hora después de
  // reemplazarlo. Al ser un logo (cambia rara vez), el costo de no cachear es
  // insignificante frente al riesgo de fidelidad histórica incorrecta.
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType, upsert: false, cacheControl: '0' })
  if (error) return { ok: false, error }
  return { ok: true }
}

// Promueve el archivo temporal a la ruta canónica. `move()` de Supabase
// Storage falla con 409 si el destino ya existe (verificado empíricamente) —
// por eso se borra el destino primero (si existía) y luego se mueve. Hay una
// ventana breve donde el destino no existe; en el peor caso una descarga de
// PDF justo en ese instante cae al fallback (nunca revienta).
export async function promoteLogo(tempPath, finalPath) {
  await supabase.storage.from(BUCKET).remove([finalPath]).catch(() => {})
  const { error } = await supabase.storage.from(BUCKET).move(tempPath, finalPath)
  if (error) return { ok: false, error }
  return { ok: true }
}

export async function removePaths(paths) {
  if (!paths || !paths.length) return { ok: true }
  const { error } = await supabase.storage.from(BUCKET).remove(paths)
  if (error) return { ok: false, error }
  return { ok: true }
}

// Descarga el logo histórico privado para usarlo en el PDF. Devuelve un Blob
// o null (nunca lanza) — el llamador decide el fallback.
export async function downloadHistoricalLogo(path) {
  if (!path) return null
  const { data, error } = await supabase.storage.from(BUCKET).download(path)
  if (error || !data) return null
  return data
}
