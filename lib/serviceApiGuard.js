// lib/serviceApiGuard.js — SOLO servidor (rutas /api/services/*).
// Fase 6.7C-1.3c / Etapa 2 — protección de API y Google Calendar ante contrataciones canceladas.
//
// NO importa credenciales ni el cliente admin: las rutas le pasan su `supabaseAdmin`. Así se puede probar con
// clientes falsos y no hay riesgo de que el navegador lo arrastre con `service_role`.
//
// IMPORTANTE: validar antes de escribir evita el efecto externo en Google cuando el rechazo ya es conocido, pero
// NO es atómico con el UPDATE ni con Google Calendar: una cancelación puede confirmarse entre la comprobación y la
// escritura. Por eso las rutas (a) revisan el resultado de cada UPDATE, (b) compensan el evento recién creado y
// (c) reconocen los errores del trigger de la Etapa 3 (DS001 / DS002 / DS004 / 55P03 / 40P01). La garantía
// definitiva la da el trigger, no esta capa.
import { isQuoteCancelled, KNOWN_LIFECYCLE } from './serviceGuard'

// Códigos estables hacia el cliente. `error` conserva el nombre de campo que ya lee el frontend (j.error).
export const API_ERRORS = {
  CONTRACT_CANCELLED: { status: 409, message: 'La contratación de esta cotización está cancelada. El servicio es solo de consulta.' },
  SERVICE_CANCELLED: { status: 409, message: 'El servicio está cancelado y no puede sincronizarse con Google Calendar.' },
  CONTRACT_UNVERIFIED: { status: 503, message: 'No se pudo verificar el estado de la contratación. No se realizó ningún cambio; intenta de nuevo.' },
  INVALID_QUOTE_RELATION: { status: 409, message: 'El servicio no puede asociarse a ese registro.' },
  CONCURRENT_OPERATION: { status: 409, message: 'Hay otra operación en curso sobre esta contratación. Actualiza la pantalla e intenta de nuevo.' },
  DB_DEADLOCK: { status: 503, message: 'Conflicto temporal en la base de datos. Intenta de nuevo.' },
  SERVICE_NOT_FOUND: { status: 404, message: 'No se encontró el servicio al guardar el cambio.' },
  DB_ERROR: { status: 500, message: 'No se pudo guardar el cambio en la base de datos.' },
}

export function apiError(code, extra = {}) {
  const d = API_ERRORS[code]
  return Response.json({ error: d.message, code, ...extra }, { status: d.status })
}

// Errores de PostgreSQL / PostgREST => código de API. NO se convierte cualquier error en 409: lo desconocido es DB_ERROR (500)
// y el texto SQL crudo nunca llega al cliente.
export function classifyDbError(error) {
  switch (error && error.code) {
    case 'DS001': return 'CONTRACT_CANCELLED'          // trigger: operación prohibida sobre contratación cancelada
    case 'DS002': return 'CONTRACT_UNVERIFIED'         // trigger: no se pudo verificar la cotización (falla cerrado)
    case 'DS004': return 'INVALID_QUOTE_RELATION'      // trigger: servicio asociado a un recibo
    case '55P03': return 'CONCURRENT_OPERATION'        // lock_not_available (NOWAIT) por una cancelación en curso
    case '40P01': return 'DB_DEADLOCK'                 // deadlock_detected
    default: return 'DB_ERROR'
  }
}

// Resultado de `supabase.from('services').update(...).eq('id', id).select('id')`.
// null = la escritura se confirmó (error nulo y exactamente la fila esperada); si no, { code, dbCode, dbMessage }.
export function updateFailure(res) {
  if (!res) return { code: 'DB_ERROR', dbCode: null, dbMessage: 'sin respuesta' }
  if (res.error) return { code: classifyDbError(res.error), dbCode: res.error.code || null, dbMessage: String(res.error.message || '').slice(0, 120) }
  if (!Array.isArray(res.data) || res.data.length !== 1) return { code: 'SERVICE_NOT_FOUND', dbCode: null, dbMessage: 'el UPDATE no afectó una fila' }
  return null
}

// Estado contractual REAL de la cotización a la que pertenece el servicio (se usa service.quote_id leído de la base;
// nunca un quoteId enviado por el navegador). Cualquier duda => unverified (se rechaza).
export async function loadQuoteForGuard(admin, quoteId, cols = 'id, status, lifecycle_status') {
  try {
    const { data, error } = await admin.from('quotes').select(cols).eq('id', quoteId).single()
    if (error || !data) return { unverified: true }
    if (!KNOWN_LIFECYCLE.includes(data.lifecycle_status)) return { unverified: true }   // nulo/desconocido: no se asume vigente
    return { quote: data }
  } catch {
    return { unverified: true }
  }
}

// ¿Está permitida esta operación para este servicio y esta cotización? null = sí; si no, el código de rechazo (409).
//   sync   : crear/actualizar un evento. Prohibido con contratación cancelada y con un servicio ya cancelado.
//   clear  : volver a "pendiente de agendar". Prohibido con contratación cancelada (sería una reactivación).
//   cancel : pasar a "cancelado" (no reactiva). Permitido, salvo un servicio REALIZADO de una contratación cancelada
//            (es histórico: la excepción X1 del trigger solo cubre pendiente/agendado/confirmado -> cancelado).
export function guardOperation(op, service, quote) {
  const cancelled = isQuoteCancelled(quote)
  if (op === 'sync') {
    if (cancelled) return 'CONTRACT_CANCELLED'
    if (service.status === 'cancelado') return 'SERVICE_CANCELLED'
  }
  if (op === 'clear' && cancelled) return 'CONTRACT_CANCELLED'
  if (op === 'cancel' && cancelled && service.status === 'realizado') return 'CONTRACT_CANCELLED'
  return null
}

// Registro de incidencias en el log del servidor. Lista blanca de campos: nunca tokens, cabeceras ni cuerpos completos.
const LOG_FIELDS = ['serviceId', 'eventId', 'dbCode', 'dbMessage', 'apiCode', 'compensation', 'discrepancy', 'detail']
export function logApi(route, info) {
  const safe = {}
  for (const k of LOG_FIELDS) if (info && info[k] !== undefined) safe[k] = typeof info[k] === 'string' ? info[k].slice(0, 200) : info[k]
  console.error(`[api/services/${route}]`, JSON.stringify(safe))
}
