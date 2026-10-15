// lib/historialLoad.js
// Carga de /historial separada de la pantalla para poder probarla sin React.
//
// Antes, `load()` descartaba el `error` de sus tres consultas: si fallaba
// `app_config` la pantalla se quedaba en «Cargando…» para siempre y si fallaba
// `quotes` o `services` se pintaba una lista vacía como si fuera válida. Aquí
// la carga es todo-o-nada: o devuelve los tres conjuntos de datos completos, o
// devuelve el fallo (nunca lanza y nunca entrega datos parciales).

export const HISTORIAL_LOAD_ERROR_MESSAGE =
  'No se pudo cargar el historial. Revisa tu conexión e inténtalo de nuevo.'
// Tras una acción de negocio ya completada (contratar, cancelar, eliminar): el
// único fallo es el de volver a consultar la lista; la acción NO se repite.
export const HISTORIAL_REFRESH_ERROR_MESSAGE =
  'La acción se completó, pero no se pudo actualizar la pantalla. No la repitas: pulsa «Reintentar» para actualizar el historial.'

// Diagnóstico: lista blanca mínima (operación, estado HTTP y código). Nunca
// mensajes crudos, sesiones, cabeceras, URLs ni cuerpos de respuesta.
const CODE_RE = /^[A-Za-z0-9_]{1,12}$/
const safeStatus = (s) => (Number.isInteger(s) && s >= 0 && s <= 599 ? s : 0) // 0 = sin respuesta HTTP
const safeCode = (c) => (typeof c === 'string' && CODE_RE.test(c) ? c : 'none')

// La consulta pide la fila id = 1 de app_config: una respuesta sin error pero
// sin esa fila (null, [], {} o con otro id) NO es una configuración válida.
const isValidConfig = (d) => !!d && typeof d === 'object' && !Array.isArray(d) && Number(d.id) === 1

// `check` valida la forma del dato; un dato inválido sin `error` también es fallo.
async function runQuery(op, make, check) {
  try {
    const res = await make()
    if (!res || res.error) {
      return { failure: { op, status: safeStatus(res?.status), code: safeCode(res?.error?.code) } }
    }
    if (!check(res.data)) return { failure: { op, status: safeStatus(res.status), code: 'EMPTY' } }
    return { data: res.data }
  } catch {
    return { failure: { op, status: 0, code: 'EXC' } }
  }
}

// client = cliente de supabase-js. Devuelve
//   { ok: true, quotes, config, services }  |  { ok: false, failures: [{ op, status, code }] }
export async function loadHistorialData(client) {
  const [q, c, s] = await Promise.all([
    runQuery('quotes', () => client.from('quotes').select('*').order('created_at', { ascending: false }), Array.isArray),
    runQuery('app_config', () => client.from('app_config').select('*').eq('id', 1).single(), isValidConfig),
    runQuery('services', () => client.from('services').select('id, quote_id, status'), Array.isArray),
  ])
  const failures = [q, c, s].filter((r) => r.failure).map((r) => r.failure)
  if (failures.length) return { ok: false, failures }
  return { ok: true, quotes: q.data, config: c.data, services: s.data }
}

// El registro vuelve a sanear cada campo: aunque alguien le pase un objeto con
// texto libre, solo salen operación conocida, estado numérico y código corto.
const KNOWN_OPS = ['quotes', 'app_config', 'services']
export function logHistorialFailures(failures, log = console.error) {
  const parts = (Array.isArray(failures) ? failures : []).map((f) => {
    const op = f && KNOWN_OPS.includes(f.op) ? f.op : 'unknown'
    return `${op}=${safeStatus(f && f.status)}/${safeCode(f && f.code)}`
  })
  log(`[historial] load_failed ${parts.join(' ')}`)
}

// Control de cargas superpuestas: solo la solicitud MÁS RECIENTE puede escribir
// el estado de la pantalla (una respuesta antigua llega tarde y se descarta) y
// `pending()` permite no lanzar otra mientras una sigue en curso. `stop()` se
// llama al desmontar.
export function createLoadTracker() {
  let latest = 0
  let settled = 0
  let alive = true
  return {
    begin() { latest += 1; return latest },
    isCurrent(id) { return alive && id === latest },
    finish(id) { if (id === latest) settled = id },
    pending() { return settled < latest },
    start() { alive = true },
    stop() { alive = false },
  }
}
