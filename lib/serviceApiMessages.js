// lib/serviceApiMessages.js
// Fase 6.7C-1.3c / Etapas 2.1 y 2.1a — mensajes de las pantallas de servicios para las respuestas de /api/services/*.
//
// Función PURA: sin React, sin credenciales, sin red. Solo traduce la respuesta estructurada de la API
// ({ ok, error, code, calendarDiscrepancy, calendarCompensated, calendarWarning }) a un mensaje claro y SEGURO.
// No cambia ninguna regla de negocio ni dispara operaciones (no reintenta, no toca Calendar).
//
// Tres cosas distintas que los mensajes no deben confundir:
//   (a) guardar el servicio en Supabase (UPDATE/INSERT que hace la pantalla ANTES de sincronizar),
//   (b) registrar en Supabase los datos de Calendar (id/enlace/estado de sincronización),
//   (c) crear, modificar o eliminar el evento en Google Calendar.
// Una falla de sincronización NO implica que (a) haya fallado. Cuando la pantalla sabe que (a) ya ocurrió lo indica
// con opts.serviceSaved. Los detalles técnicos (texto de Google, SQL, trazas) nunca llegan al usuario: quedan en los
// registros seguros del servidor.

const SYNC_INCOMPLETE = 'No se pudo completar la sincronización con Google Calendar.'

export const DISCREPANCY_MESSAGES = {
  // Se creó un evento en Google, falló su registro en Supabase y la compensación tampoco pudo eliminarlo.
  event_orphaned: SYNC_INCOMPLETE + ' Es posible que se haya creado un evento que no quedó registrado en el sistema. Revisa tu calendario antes de volver a intentarlo para evitar duplicados.',
  // Se actualizó un evento ya existente en Google y falló el registro de esa actualización en Supabase.
  event_modified: SYNC_INCOMPLETE + ' El evento existente podría haberse actualizado en el calendario, pero el sistema no registró esa actualización. Verifica ambos registros antes de volver a intentarlo.',
  // Se eliminó el evento en Google y la base NO pudo guardar el cambio del servicio (clear-schedule / cancel: aquí el
  // cambio de estado del servicio sí es lo que no se guardó).
  event_deleted_db_unchanged: 'El evento de Google Calendar pudo haberse eliminado, pero el sistema no logró actualizar el servicio. Revisa su estado antes de repetir la operación.',
}

// Se creó un evento, falló su registro y la API logró eliminar el evento recién creado.
export const COMPENSATED_MESSAGE = SYNC_INCOMPLETE + ' El evento creado durante el intento fue eliminado de Google Calendar.'

// La operación en Supabase concluyó, pero no se pudo confirmar el borrado del evento en Calendar.
export const WARNING_MESSAGES = {
  event_delete_failed: 'El servicio se actualizó, pero no se pudo confirmar la eliminación del evento en Google Calendar. Revísalo manualmente.',
}

// Se antepone cuando la pantalla YA guardó el servicio y lo que falló es la sincronización.
export const SERVICE_SAVED_PREFIX = 'El servicio se guardó. '

// Códigos estables de la API. retrySafe = ¿tiene sentido sugerir "reintentar" tal cual?
// syncRelated = el mensaje trata de la sincronización con Calendar (admite el prefijo "El servicio se guardó.").
export const CODE_MESSAGES = {
  // contractuales / concurrencia (Etapa 2.1: se conservan)
  CONTRACT_CANCELLED: { message: 'La contratación de esta cotización fue cancelada, por lo que el servicio es solo de consulta. Actualiza la pantalla para ver su estado actual.', retrySafe: false },
  SERVICE_CANCELLED: { message: 'El servicio está cancelado y no puede sincronizarse con Google Calendar.', retrySafe: false },
  CONTRACT_UNVERIFIED: { message: 'No se pudo verificar el estado de la contratación, así que no se realizó ningún cambio. Intenta de nuevo en unos momentos.', retrySafe: true },
  CONCURRENT_OPERATION: { message: 'Hay otra operación en curso sobre esta contratación. Actualiza la información antes de intentar de nuevo.', retrySafe: true },
  INVALID_QUOTE_RELATION: { message: 'El servicio no puede asociarse a ese registro. Verifica que corresponda a una cotización contratada.', retrySafe: false },
  // técnicos: el texto original (Google / SQL) se sustituye por un mensaje seguro (Etapa 2.1a)
  CALENDAR_ERROR: { message: 'No se pudo completar la operación con Google Calendar. Revisa el estado del servicio antes de volver a intentarlo.', retrySafe: true, syncRelated: true },
  DB_ERROR: { message: 'No se pudo completar la operación en el sistema. Actualiza la información e inténtalo nuevamente.', retrySafe: true, syncRelated: true },
  DB_DEADLOCK: { message: 'Hay otra operación en curso. Actualiza la información antes de intentarlo nuevamente.', retrySafe: true, syncRelated: true },
  SERVICE_NOT_FOUND: { message: 'No se encontró el servicio. Actualiza la información e inténtalo nuevamente.', retrySafe: true, syncRelated: false },
}

// Mensaje seguro cuando no hay un código reconocido ni un texto de la API que se pueda mostrar.
export const UNKNOWN_ERROR_MESSAGE = 'No se pudo completar la operación. Actualiza la información e inténtalo nuevamente.'

// Mensajes FIJOS que escriben nuestras propias rutas (sin código) y que son claros y seguros: se muestran tal cual.
// Todo lo demás que venga sin código reconocido (p. ej. el err.message del catch general) se sustituye.
export const PASSTHROUGH_ERRORS = [
  'No autorizado.',
  'Sesión inválida.',
  'Falta serviceId.',
  'No se encontró el servicio.',
  'Este servicio todavía no tiene fecha y hora — no hay nada que sincronizar aún.',
]

// Errores ACCIONABLES de lib/googleCalendar.js (la persona sabe qué hacer). Se reconocen por su inicio y se muestran con
// un texto propio y seguro: así no se pierde la indicación de reconectar, pero tampoco se muestra el detalle de Google.
export const CALENDAR_NOT_CONNECTED_MESSAGE = 'Tu Google Calendar no está conectado o la conexión expiró. Ve a Configuración → "Mi Google Calendar" y vuelve a conectarlo.'
function isCalendarConnectionError(text) {
  return typeof text === 'string' && (text.startsWith('Todavía no conectaste tu Google Calendar') || text.startsWith('No se pudo refrescar tu token de Google'))
}

const has = (obj, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key)

// resp = { ok: boolean, body: objeto JSON de la respuesta (o undefined/{} si no se pudo leer) }
// opts = { genericPrefix, fallback, serviceSaved }
//   - fallback / genericPrefix conservan el mensaje EXISTENTE de cada acción cuando la API no dice nada más:
//       mensaje = genericPrefix + (texto fijo de la API || fallback)
//   - serviceSaved:true => la pantalla ya guardó el servicio (UPDATE/INSERT) y lo que falló es la sincronización.
//
// Devuelve null (éxito completo) o { kind, level, message, retrySafe, code }:
//   kind  'discrepancy' | 'compensated' | 'warning' | 'code' | 'generic'
//   level 'error' | 'warning'   ('warning' = se guardó pero hay algo que revisar)
//
// Prioridad (sin cambios respecto a la Etapa 2.1): 1) discrepancia confirmada, 2) compensación confirmada,
// 3) advertencia de Calendar (solo con ok === true), 4) código reconocido, 5) mensaje genérico seguro.
// Un solo mensaje por respuesta.
export function describeServiceApiResult(resp, opts = {}) {
  const ok = !!(resp && resp.ok === true)
  const b = resp && resp.body && typeof resp.body === 'object' && !Array.isArray(resp.body) ? resp.body : {}
  const code = typeof b.code === 'string' ? b.code : null
  const saved = opts.serviceSaved === true
  const withSaved = (message, syncRelated) => (saved && syncRelated ? SERVICE_SAVED_PREFIX + message : message)

  if (has(DISCREPANCY_MESSAGES, b.calendarDiscrepancy)) {
    // C (clear/cancel) habla del cambio de estado del servicio: no lleva el prefijo. A y B son de sincronización.
    const syncRelated = b.calendarDiscrepancy !== 'event_deleted_db_unchanged'
    return { kind: 'discrepancy', level: 'error', message: withSaved(DISCREPANCY_MESSAGES[b.calendarDiscrepancy], syncRelated), retrySafe: false, code }
  }
  if (b.calendarCompensated === true) {
    return { kind: 'compensated', level: 'error', message: withSaved(COMPENSATED_MESSAGE, true), retrySafe: true, code }
  }
  if (ok) {
    if (has(WARNING_MESSAGES, b.calendarWarning)) {
      return { kind: 'warning', level: 'warning', message: WARNING_MESSAGES[b.calendarWarning], retrySafe: false, code }
    }
    return null                                   // éxito completo
  }
  if (code && has(CODE_MESSAGES, code)) {
    const c = CODE_MESSAGES[code]
    // Un fallo de Calendar por conexión (no conectado / token vencido) tiene una indicación accionable propia.
    if (code === 'CALENDAR_ERROR' && isCalendarConnectionError(b.error)) {
      return { kind: 'code', level: 'error', message: withSaved(CALENDAR_NOT_CONNECTED_MESSAGE, true), retrySafe: true, code }
    }
    return { kind: 'code', level: 'error', message: withSaved(c.message, c.syncRelated === true), retrySafe: c.retrySafe, code }
  }

  // Sin código reconocido: solo se muestran los textos FIJOS conocidos; cualquier otro texto de la API se sustituye.
  const { genericPrefix = '', fallback = 'No se pudo completar la operación.' } = opts
  if (typeof b.error !== 'string' || b.error === '') {
    return { kind: 'generic', level: 'error', message: genericPrefix + fallback, retrySafe: true, code }          // la API no dijo nada: texto existente de la acción
  }
  if (PASSTHROUGH_ERRORS.includes(b.error)) {
    return { kind: 'generic', level: 'error', message: genericPrefix + b.error, retrySafe: true, code }
  }
  if (isCalendarConnectionError(b.error)) {
    return { kind: 'generic', level: 'error', message: withSaved(CALENDAR_NOT_CONNECTED_MESSAGE, true), retrySafe: true, code }
  }
  return { kind: 'generic', level: 'error', message: withSaved(UNKNOWN_ERROR_MESSAGE, true), retrySafe: true, code }
}

// Texto del aviso que muestra /servicios/nuevo cuando el servicio YA se guardó (INSERT) pero la sincronización falló.
// Es modal (alert), así que el mensaje se ve antes de navegar. Solo sugiere "reintentar" cuando hacerlo es seguro.
export function newServiceSyncAlertText(body) {
  const d = describeServiceApiResult({ ok: false, body }, { fallback: CODE_MESSAGES.CALENDAR_ERROR.message, serviceSaved: true })
  const retry = '\n\nPuedes reintentar desde la pantalla del servicio.'
  const startsWithSaved = d.message.startsWith(SERVICE_SAVED_PREFIX)
  // Mensajes de sincronización ya empiezan con "El servicio se guardó."; el resto (códigos contractuales, textos fijos)
  // necesitan la frase que aclara que el servicio sí quedó guardado.
  const text = startsWithSaved ? d.message : 'El servicio se guardó, pero no se pudo sincronizar con Google Calendar.\n\n' + d.message
  return text + (d.retrySafe ? retry : '')
}
