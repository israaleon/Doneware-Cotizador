// lib/storageVerifiedRemove.js
// Migración 2 (protección de Storage) — borrado VERIFICADO por rutas esperadas.
//
// Con las políticas RESTRICTIVE de storage.objects, `remove()` responde ÉXITO con
// una lista vacía cuando la política impide borrar un objeto (no hay error). Por
// eso `error == null` o `data.length` NO bastan para afirmar una limpieza: aquí
// se comprueba, listando la carpeta antes y después, qué rutas ESPERADAS existían
// y cuáles siguen existiendo. Nunca se borra nada que no esté en la lista pedida
// (ni fuera del prefijo autorizado, si se indica), y nunca se afirma éxito si no se
// pudo verificar. Un listado fallido, incompleto, ilegible o sin permisos NUNCA
// demuestra que un archivo no exista.
import { supabase } from './supabaseClient'

const BUCKET = 'quote_documents'
const PAGE = 1000          // tamaño de página que se pide (el servidor puede devolver menos)
const BATCH = 100          // rutas por llamada a remove()
const MAX_PAGES = 100

function splitPath(p) {
  const i = p.lastIndexOf('/')
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i), name: p.slice(i + 1) }
}

// Una ruta es segura si no está vacía, no empieza ni termina con «/», no tiene segmentos vacíos ni «.»/«..».
function isSafePath(p) {
  return typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.endsWith('/') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
}

// Entradas (archivos y subcarpetas) que hay DIRECTAMENTE en `dir`.
//   files:   nombres de archivos (id distinto de null)   folders: nombres de subcarpetas (id === null)
// Devuelve { names, folders, error }; `names` es null si el listado NO es fiable:
//   * error, excepción o formato inesperado (incluida cualquier entrada ilegible);
//   * solo una página VACÍA demuestra que se terminó (no se deduce el final de «página menor que el límite»: el servidor puede limitar el tamaño);
//   * una página sin entradas nuevas (el servidor ignora el desplazamiento) o demasiadas páginas => error.
export async function listDirNames(dir, { sb = supabase, bucket = BUCKET } = {}) {
  const names = new Set()
  const folders = new Set()
  let offset = 0
  for (let n = 0; n < MAX_PAGES; n++) {
    let res
    try {
      res = await sb.storage.from(bucket).list(dir, { limit: PAGE, offset })
    } catch (e) {
      return { names: null, folders: null, error: e }
    }
    if (!res || res.error) return { names: null, folders: null, error: (res && res.error) || new Error('list sin respuesta') }
    if (!Array.isArray(res.data)) return { names: null, folders: null, error: new Error('list devolvió un formato inesperado') }
    if (res.data.some((o) => !o || typeof o !== 'object' || typeof o.name !== 'string' || !o.name)) {
      return { names: null, folders: null, error: new Error('list devolvió una entrada ilegible') }
    }
    if (res.data.length === 0) return { names, folders, error: null }
    let added = 0
    for (const o of res.data) {
      const set = o.id === null ? folders : names
      if (!set.has(o.name)) { set.add(o.name); added++ }
    }
    if (!added) return { names: null, folders: null, error: new Error('paginación inconsistente') }
    offset += res.data.length
  }
  return { names: null, folders: null, error: new Error('list excedió el máximo de páginas') }
}

// Rutas completas (dir/nombre) que EXISTEN ahora entre las pedidas. { present: Set|null, error }
async function presentAmong(paths, deps) {
  const present = new Set()
  const byDir = new Map()
  for (const p of paths) {
    const { dir, name } = splitPath(p)
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir).push({ p, name })
  }
  for (const [dir, items] of byDir) {
    const { names, error } = await listDirNames(dir, deps)
    if (!names) return { present: null, error }
    for (const { p, name } of items) if (names.has(name)) present.add(p)   // coincidencia EXACTA de nombre de archivo (no prefijos ni carpetas)
  }
  return { present, error: null }
}

const msg = (e) => (e && e.message ? String(e.message) : e ? String(e) : null)

// Elimina `paths` y VERIFICA el resultado por ruta.
//   status: 'nothing_to_do' | 'already_absent' | 'removed' | 'partial' | 'not_removed' | 'unverified' | 'rejected_paths'
//   ok:     true solo si, tras la operación, ninguna ruta pedida sigue existiendo (comprobado listando)
//   removed: existían y ya no existen; remaining: SIGUEN existiendo (comprobado); absent: no existían antes de borrar;
//   unverified: rutas cuyo estado NO se pudo comprobar (no cuentan como «siguen allí» ni como eliminadas).
//   allowedPrefix: si se indica, TODA ruta debe empezar con él; cualquier ruta ajena o insegura => 'rejected_paths' y no se hace NADA.
export async function removeVerified(paths, { sb = supabase, bucket = BUCKET, allowedPrefix = null } = {}) {
  const requested = [...new Set((paths || []).filter((p) => typeof p === 'string' && p))]
  const base = { requested, removed: [], remaining: [], absent: [], unverified: [], rejected: [], error: null }
  if (!requested.length) return { ...base, ok: true, status: 'nothing_to_do' }
  const rejected = requested.filter((p) => !isSafePath(p) || (allowedPrefix && !p.startsWith(allowedPrefix)))
  if (rejected.length) return { ...base, ok: false, status: 'rejected_paths', rejected, error: 'rutas no autorizadas' }
  const deps = { sb, bucket }

  const before = await presentAmong(requested, deps)
  // Si no se pudo saber qué existe se intenta borrar lo pedido (solo lo pedido), pero solo se afirma éxito si luego se puede verificar.
  const toRemove = before.present ? requested.filter((p) => before.present.has(p)) : requested
  const absent = before.present ? requested.filter((p) => !before.present.has(p)) : []
  if (before.present && !toRemove.length) return { ...base, ok: true, status: 'already_absent', absent }

  let removeError = null
  for (let i = 0; i < toRemove.length; i += BATCH) {
    try {
      const res = await sb.storage.from(bucket).remove(toRemove.slice(i, i + BATCH))
      if (res && res.error && !removeError) removeError = msg(res.error)
    } catch (e) {
      if (!removeError) removeError = msg(e) || 'error al borrar'
    }
  }

  const after = await presentAmong(toRemove, deps)
  if (!after.present) {
    return { ...base, ok: false, status: 'unverified', absent, unverified: toRemove, error: removeError || msg(after.error) || 'no se pudo verificar' }
  }
  const remaining = toRemove.filter((p) => after.present.has(p))
  const removed = toRemove.filter((p) => !after.present.has(p))
  if (!remaining.length) return { ...base, ok: true, status: 'removed', removed, absent, error: removeError }
  return { ...base, ok: false, status: removed.length ? 'partial' : 'not_removed', removed, absent, remaining, error: removeError }
}

// Aviso para una cotización YA eliminada cuya limpieza de archivos quedó incompleta. No sugiere repetir la eliminación.
// Solo muestra un NÚMERO cuando es exacto (todos los resultados con fallo fueron verificados por listado);
// si algún estado no se pudo determinar, dice que la limpieza no pudo verificarse.
export function describeCleanupPending(folio, results) {
  const bad = (results || []).filter((r) => !r || r.ok !== true)
  const exact = bad.length > 0 && bad.every((r) => r && (r.status === 'partial' || r.status === 'not_removed') && Array.isArray(r.remaining) && (!r.unverified || !r.unverified.length))
  const n = exact ? bad.reduce((s, r) => s + r.remaining.length, 0) : null
  return (
    `La cotización ${folio} se eliminó correctamente: NO repitas la eliminación.\n\n` +
    (exact
      ? `La limpieza de sus archivos en Storage quedó PENDIENTE (${n} archivo(s) siguen allí).`
      : `La limpieza de sus archivos en Storage quedó PENDIENTE y no pudo verificarse (puede haber archivos sin eliminar).`) +
    ` No afecta a la cotización ni al resto del sistema; los archivos quedan sin uso hasta una limpieza posterior.`
  )
}
