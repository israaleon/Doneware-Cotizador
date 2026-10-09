// app/api/services/clear-schedule/route.js
// Se llama cuando un servicio pasa a "Pendiente de agendar": el cliente aún
// no define fecha, así que no debe quedar fecha ni evento en Google Calendar
// (a diferencia de "Cancelado", este estatus sí espera que más adelante se
// vuelva a agendar).
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

    // Fase 6.7C-1.3c / Etapa 2 — volver a "pendiente de agendar" sería REACTIVAR un servicio histórico: con la
    // contratación cancelada (o sin poder verificarla) se rechaza ANTES de borrar nada en Google Calendar.
    const { quote, unverified } = await loadQuoteForGuard(supabaseAdmin, service.quote_id)
    if (unverified) return apiError('CONTRACT_UNVERIFIED')
    const blocked = guardOperation('clear', service, quote)
    if (blocked) return apiError(blocked)

    let eventDeleted = false
    let deleteFailed = false
    if (service.google_event_id && service.calendar_owner) {
      try { await deleteEvent(service.calendar_owner, service.google_event_id); eventDeleted = true }
      catch { deleteFailed = true /* si falla borrar el evento, igual limpiamos el servicio localmente */ }
    }

    const saved = updateFailure(await supabaseAdmin.from('services').update({
      status: 'pendiente_agendar',
      start_at: null,
      google_event_id: null,
      google_event_link: null,
      sync_status: 'no_agendado',
      sync_error: null,
      updated_at: new Date().toISOString(),
    }).eq('id', serviceId).select('id'))

    if (saved) {
      // Si el evento ya se eliminó en Google pero la base no cambió, la discrepancia se reporta (no se oculta):
      // la fila sigue apuntando a un evento que ya no existe. Reintentar es seguro (deleteEvent tolera 404/410).
      const extra = eventDeleted ? { calendarDiscrepancy: 'event_deleted_db_unchanged' } : {}
      logApi('clear-schedule', { serviceId, apiCode: saved.code, dbCode: saved.dbCode, dbMessage: saved.dbMessage, discrepancy: extra.calendarDiscrepancy || null })
      return apiError(saved.code, extra)
    }

    return Response.json({ ok: true, ...(deleteFailed ? { calendarWarning: 'event_delete_failed' } : {}) })
  } catch (err) {
    return Response.json({ error: err.message || 'Error inesperado.' }, { status: 500 })
  }
}
