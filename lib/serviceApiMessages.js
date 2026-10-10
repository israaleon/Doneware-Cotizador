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

// ---------- Escrituras directas del navegador a `services` (Fase 6.7C-1.3c / Etapa 2.2) ----------
// El navegador escribe en Supabase sin pasar por /api/services/*. Si PostgreSQL (trigger, RLS, restricciones) rechaza la
// operación, supabase-js devuelve un PostgrestError { code, message, details, hint }. `code` es el SQLSTATE; message/details/
// hint son texto técnico y NUNCA se muestran. Solo se reconocen por `code` (jamás por texto libre) estos cinco:
//   DS001  contratación cancelada: el trigger rechaza crear, modificar, mover o eliminar servicios de esa cotización.
//   DS002  el trigger no pudo verificar la cotización asociada (no visible / inexistente): falla cerrada.
//   DS004  el servicio se intentó asociar a un documento que no es una cotización (recibo). Solo en INSERT.
//   55P03  lock_not_available: otra operación (p. ej. la cancelación de la contratación) retiene el bloqueo (NOWAIT).
//   40P01  deadlock_detected: PostgreSQL abortó esta operación para resolver un interbloqueo.
export const WRITE_ERROR_MESSAGES = {
  // DS001 cubre alta y edición: el texto dice "guardar" para no afirmar que el servicio ya existía.
  DS001: 'No se puede guardar este servicio porque la contratación está cancelada. Actualiza la información.',
  DS002: 'No fue posible verificar el estado de la contratación. Inténtalo nuevamente más tarde.',
  DS004: 'No se puede completar la operación porque la relación del servicio con su documento no es válida.',
  // El bloqueo puede ser del servicio o de su cotización: el texto no precisa cuál.
  '55P03': 'El servicio o su contratación está siendo actualizado por otra operación. Espera un momento, actualiza la información e inténtalo nuevamente.',
  '40P01': 'Se produjo un conflicto entre operaciones simultáneas. Actualiza la información antes de volver a intentarlo.',
}

// Mensaje seguro para cualquier otro error (permisos/RLS, llaves foráneas, restricciones, red, sin código, nulo...).
export const WRITE_ERROR_FALLBACK = 'No se pudo guardar el servicio. Actualiza la información e inténtalo nuevamente.'

// Código SQLSTATE del error, o null. Nunca lanza (el error puede ser null, un objeto incompleto o tener getters que fallen).
function errorCodeOf(error) {
  try {
    return error && typeof error === 'object' && typeof error.code === 'string' ? error.code : null
  } catch {
    return null
  }
}

// Función PURA: traduce el `error` de un insert/update directo sobre `services` a { message, code, contractCancelled, unconfirmed }.
//   message            texto seguro para mostrar (nunca contiene texto del error original)
//   code               el código reconocido (DS001, DS002, DS004, 55P03, 40P01) o null
//   contractCancelled  true solo con DS001 (la pantalla de detalle puede pasar a solo consulta)
//   unconfirmed        true si NO hubo respuesta HTTP (status === 0: red caída, corte, timeout): la escritura pudo haberse
//                      aplicado aunque la respuesta no llegara, así que no se afirma que "no se guardó" (Etapa 2.2a)
// `status` es el campo `status` de la respuesta de supabase-js ({ error, status }); es opcional. supabase-js NO lanza ante un
// fallo de red: devuelve error sin código y status 0. Un código reconocido siempre gana (hubo respuesta de la base).
// No modifica el error, no hace peticiones, no reintenta y no convierte un error en éxito (siempre devuelve un mensaje).
export function describeServiceWriteError(error, status) {
  const code = errorCodeOf(error)
  if (code && has(WRITE_ERROR_MESSAGES, code)) {
    return { message: WRITE_ERROR_MESSAGES[code], code, contractCancelled: code === 'DS001', unconfirmed: false }
  }
  // Etapa 2.2b: un 5xx de infraestructura (502/503/504...) SIN código de la base tampoco dice si la escritura se aplicó.
  // Un 5xx con código (p. ej. 55P03, otros SQLSTATE) sí es una respuesta de la base y sigue su camino normal.
  if (status === 0 || (!code && typeof status === 'number' && status >= 500)) {
    return { message: UNCONFIRMED_MESSAGES.write_unknown, code: null, contractCancelled: false, unconfirmed: true }
  }
  return { message: WRITE_ERROR_FALLBACK, code: null, contractCancelled: false, unconfirmed: false }
}

// ---------- Resultado NO confirmado (Fase 6.7C-1.3c / Etapa 2.2a) ----------
// Cuando una petición lanza una excepción (red, corte, sesión) NO se sabe si el servidor llegó a ejecutarla: puede haber
// creado/modificado/eliminado el evento de Calendar o haber guardado en la base aunque la respuesta no llegara.
// Por eso estos mensajes no afirman éxito ni fracaso definitivo; recomiendan revisar antes de reintentar.
//   stage: qué es lo que SÍ se sabe cuando ocurrió la excepción
//     calendar_after_save  el servicio ya se guardó en Supabase (confirmado) y falló/no respondió la sincronización con Calendar
//     calendar_unknown     la ruta pudo haber tocado Calendar y/o la base y no hay respuesta (resultado completo desconocido)
//     write_unknown        el INSERT/UPDATE directo no devolvió respuesta: no se sabe si se aplicó
//     not_started          la excepción ocurrió antes de enviar nada: seguro que no hubo cambios
export const UNCONFIRMED_MESSAGES = {
  calendar_after_save: 'El servicio se guardó, pero no fue posible confirmar el resultado de la operación con Google Calendar. Revisa el servicio y tu calendario antes de volver a intentarlo para evitar eventos duplicados.',
  calendar_unknown: 'No fue posible confirmar el resultado de la operación. Revisa el estado del servicio y Google Calendar antes de volver a intentarlo.',
  write_unknown: 'No fue posible confirmar si el servicio se guardó. Revisa el estado del servicio en la lista de servicios antes de volver a intentarlo.',
  not_started: 'No se pudo iniciar la operación y no se realizó ningún cambio. Inténtalo nuevamente.',
}

// Estado persistido en services.sync_status === 'error': el detalle guardado en services.sync_error es TEXTO TÉCNICO NO
// CONFIABLE (Google, rutas, identificadores, valores históricos) y nunca se muestra; se usa este aviso fijo.
export const SYNC_ERROR_NOTICE = 'Se detectó un problema en la última sincronización con Google Calendar. Revisa el estado del evento antes de volver a intentarlo.'

// Función PURA. Devuelve { kind: 'unconfirmed', level, message, retrySafe, code: null } con la misma forma que
// describeServiceApiResult, para mostrarse con el mismo mecanismo. Una etapa desconocida se trata como la más conservadora.
// Solo 'not_started' es un error con reintento seguro; el resto son advertencias: el resultado es desconocido.
export function describeUnconfirmedOperation(stage) {
  const key = has(UNCONFIRMED_MESSAGES, stage) ? stage : 'calendar_unknown'
  const safe = key === 'not_started'
  return { kind: 'unconfirmed', level: safe ? 'error' : 'warning', message: UNCONFIRMED_MESSAGES[key], retrySafe: safe, code: null }
}

// ---------- Respuestas HTTP de infraestructura (Fase 6.7C-1.3c / Etapa 2.2b) ----------
// Nuestras rutas /api/services/* responden SIEMPRE con JSON { error, code?, calendarDiscrepancy?, ... }. Un 5xx que no cumple ese
// contrato (HTML de Vercel, texto plano, cuerpo vacío, JSON ajeno) lo produce la infraestructura (502/503/504, función caída o
// con plazo vencido): la ruta pudo haber ejecutado la operación total o parcialmente, así que NO se interpreta como fallo.
// Un 4xx sin JSON (rechazo de plataforma antes de ejecutar la ruta) y cualquier respuesta con el contrato siguen su camino normal.
function hasApiContract(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  return typeof body.error === 'string' || typeof body.code === 'string' || typeof body.calendarDiscrepancy === 'string'
    || typeof body.calendarWarning === 'string' || body.calendarCompensated === true
}

// resp = { ok, status, body } (lo que devuelve fetchServiceApi). Función PURA.
export function isInfrastructureFailure(resp) {
  if (!resp || resp.ok === true) return false
  return typeof resp.status === 'number' && resp.status >= 500 && !hasApiContract(resp.body)
}

// Mensaje para una respuesta NO exitosa de una ruta: resultado desconocido si es de infraestructura (en la etapa indicada:
// 'calendar_after_save' si el servicio ya estaba guardado en esta operación, 'calendar_unknown' si no), o el mensaje de siempre
// (describeServiceApiResult, sin cambios) si la API respondió con su contrato.
export function describeServiceApiFailure(resp, unknownStage, opts) {
  if (isInfrastructureFailure(resp)) return describeUnconfirmedOperation(unknownStage)
  return describeServiceApiResult({ ok: false, body: resp && resp.body }, opts)
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
