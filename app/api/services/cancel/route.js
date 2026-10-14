// app/api/services/cancel/route.js
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { deleteEvent } from '@/lib/googleCalendar'
import { apiError, loadQuoteForGuard, guardOperation, updateFailure, logApi } from '@/lib/serviceApiGuard'

export async function POST(request) {
  try {
    const authHeader = request.headers.get('authorization') || ''
    const token = authHeader.replace('Bearer ', '')
    if (!token) return Response.json({ error: 'No autorizado.' }, { status: 401 })
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token)
    if (userError || !userData?.user) return Response.json({ error: 'Sesión inválida.' }, { status: 401 })

    const { serviceId } = await request.json()
    if (!serviceId) return Response.json({ error: 'Falta serviceId.' }, { status: 400 })
    const { data: service, error: svcError } = await supabaseAdmin.from('services').select('*').eq('id', serviceId).single()
    if (svcError || !service) return Response.json({ error: 'No se encontró el servicio.' }, { status: 404 })

    // Fase 6.7C-1.3c / Etapa 2 — cancelar NO reactiva, así que sigue permitido (también en una contratación cancelada,
    // para dejar servicios residuales como "cancelado"). Lo que se rechaza ANTES de tocar Google Calendar es un servicio
    // REALIZADO de una contratación cancelada: es histórico y la base (trigger V2) rechazaría su cambio de todos modos.
    // Las columnas que escribe esta ruta (status, google_event_id/link, sync_status, sync_error, updated_at) coinciden
    // exactamente con las excepciones X1/X2 del trigger V2 (limpieza solo a NULL / 'no_agendado').
    const { quote, unverified } = await loadQuoteForGuard(supabaseAdmin, service.quote_id)
    if (unverified) return apiError('CONTRACT_UNVERIFIED')
    const blocked = guardOperation('cancel', service, quote)
    if (blocked) return apiError(blocked)

    // Fase B / D-01 — el servicio SIEMPRE se cancela (regla existente), pero la referencia al evento solo se borra cuando Google
    // CONFIRMÓ que ya no existe (borrado real, o 404/410). Cualquier otra cosa (5xx, red, token revocado, respuesta perdida, o un
    // evento sin dueño de calendario al que pedírselo) deja la limpieza PENDIENTE: se conservan google_event_id / google_event_link /
    // sync_status para poder reintentar (volver a cancelar es idempotente y nunca reactiva) y la respuesta lo advierte.
    //   'none' sin evento | 'deleted' | 'already_gone' | 'pending'
    let cleanup = 'none'
    if (service.google_event_id) {
      if (service.calendar_owner) {
        try {
          const result = await deleteEvent(service.calendar_owner, service.google_event_id)
          cleanup = result === 'deleted' || result === 'already_gone' ? result : 'pending'     // un retorno inesperado nunca se toma por borrado
        } catch { cleanup = 'pending' }
      } else {
        cleanup = 'pending'            // sin dueño del calendario no se puede borrar ni verificar el evento
      }
    }
    const eventDeleted = cleanup === 'deleted' || cleanup === 'already_gone'

    // Pendiente: solo cambia el estado (cabe en las excepciones X1/X2 del trigger, que solo permiten LIMPIAR campos de Calendar).
    const update = { status: 'cancelado', updated_at: new Date().toISOString() }
    if (eventDeleted || cleanup === 'none') Object.assign(update, { google_event_id: null, google_event_link: null, sync_status: 'no_agendado', sync_error: null })
    const saved = updateFailure(await supabaseAdmin.from('services').update(update).eq('id', serviceId).select('id'))

    if (saved) {
      // Evento ya eliminado pero la fila no cambió: se reporta. Reintentar la cancelación es seguro (404/410 se toleran).
      const extra = eventDeleted ? { calendarDiscrepancy: 'event_deleted_db_unchanged' } : {}
      logApi('cancel', { serviceId, apiCode: saved.code, dbCode: saved.dbCode, dbMessage: saved.dbMessage, discrepancy: extra.calendarDiscrepancy || null })
      return apiError(saved.code, extra)
    }

    return Response.json({ ok: true, ...(cleanup === 'pending' ? { calendarWarning: 'event_delete_pending' } : {}) })
  } catch (err) {
    return Response.json({ error: err.message || 'Error inesperado.' }, { status: 500 })
  }
}
