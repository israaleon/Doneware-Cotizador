// lib/inicioLoad.js — N2 (ronda Donnie): lecturas de la página Inicio (resumen y últimas cotizaciones).
// Solo lecturas sobre tablas y columnas EXISTENTES (quotes, services); mismo criterio que lib/historialLoad.js: la carga es todo-o-nada,
// nunca lanza y nunca entrega datos parciales; un fallo NO se confunde con «sin datos» (0 cotizaciones es un resultado válido y distinto).
// Estados reales: los de lib/quoteLifecycle.js (status='cotizacion' + lifecycle_status) y services.status de lib/serviceStatus.js.

export const INICIO_LOAD_ERROR_MESSAGE = 'No se pudo cargar el resumen. Revisa tu conexión e inténtalo de nuevo.'
export const RECENT_LIMIT = 5

// Diagnóstico: lista blanca mínima (operación, estado HTTP y código); nunca mensajes crudos, sesiones, cabeceras, URLs ni cuerpos.
const CODE_RE = /^[A-Za-z0-9_]{1,12}$/
const safeStatus = (s) => (Number.isInteger(s) && s >= 0 && s <= 599 ? s : 0)
const safeCode = (c) => (typeof c === 'string' && CODE_RE.test(c) ? c : 'none')

async function run(op, make, pick) {
  try {
    const res = await make()
    if (!res || res.error) return { failure: { op, status: safeStatus(res && res.status), code: safeCode(res && res.error && res.error.code) } }
    const value = pick(res)
    if (value === undefined) return { failure: { op, status: safeStatus(res.status), code: 'EMPTY' } }
    return { value }
  } catch {
    return { failure: { op, status: 0, code: 'EXC' } }
  }
}

const asCount = (res) => (Number.isInteger(res.count) && res.count >= 0 ? res.count : undefined)
const asRows = (res) => (Array.isArray(res.data) ? res.data : undefined)

// client = cliente de supabase-js. Devuelve
//   { ok: true, counts: { precontractual, contracted, cancelled, pendingServices }, recent: [fila de quotes, …] }
//   | { ok: false, failures: [{ op, status, code }] }
export async function loadInicioData(client) {
  const quotes = () => client.from('quotes').select('id', { count: 'exact', head: true }).eq('status', 'cotizacion')
  const [pre, con, can, svc, rec] = await Promise.all([
    run('quotes_open', () => quotes().eq('lifecycle_status', 'cotizacion'), asCount),
    run('quotes_contracted', () => quotes().eq('lifecycle_status', 'contratado'), asCount),
    run('quotes_cancelled', () => quotes().eq('lifecycle_status', 'cancelado'), asCount),
    run('services_pending', () => client.from('services').select('id', { count: 'exact', head: true }).eq('status', 'pendiente_agendar'), asCount),
    run('quotes_recent', () => client.from('quotes').select('id, folio, client_name, created_at, status, lifecycle_status').eq('status', 'cotizacion').order('created_at', { ascending: false }).limit(RECENT_LIMIT), asRows),
  ])
  const failures = [pre, con, can, svc, rec].filter((r) => r.failure).map((r) => r.failure)
  if (failures.length) return { ok: false, failures }
  return { ok: true, counts: { precontractual: pre.value, contracted: con.value, cancelled: can.value, pendingServices: svc.value }, recent: rec.value }
}

const KNOWN_OPS = ['quotes_open', 'quotes_contracted', 'quotes_cancelled', 'services_pending', 'quotes_recent']
export function logInicioFailures(failures, log = console.error) {
  const parts = (Array.isArray(failures) ? failures : []).map((f) => {
    const op = f && KNOWN_OPS.includes(f.op) ? f.op : 'unknown'
    return `${op}=${safeStatus(f && f.status)}/${safeCode(f && f.code)}`
  })
  log(`[inicio] load_failed ${parts.join(' ')}`)
}

// «Sin datos» real: la carga salió bien y no hay ninguna cotización (distinto de un fallo de carga).
export const isInicioEmpty = (data) => !!data && data.ok === true && data.recent.length === 0 && data.counts.precontractual + data.counts.contracted + data.counts.cancelled === 0
