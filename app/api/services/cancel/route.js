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

    let eventDeleted = false
    if (service.google_event_id && service.calendar_owner) {
      try { await deleteEvent(service.calendar_owner, service.google_event_id); eventDeleted = true }
      catch { /* si falla borrar el evento, igual cancelamos el servicio localmente */ }
    }

    const saved = updateFailure(await supabaseAdmin.from('services').update({
      status: 'cancelado',
      google_event_id: null,
      google_event_link: null,
      sync_status: 'no_agendado',
      sync_error: null,
      updated_at: new Date().toISOString(),
    }).eq('id', serviceId).select('id'))

    if (saved) {
      // Evento ya eliminado pero la fila no cambió: se reporta. Reintentar la cancelación es seguro (404/410 se toleran).
      const extra = eventDeleted ? { calendarDiscrepancy: 'event_deleted_db_unchanged' } : {}
      logApi('cancel', { serviceId, apiCode: saved.code, dbCode: saved.dbCode, dbMessage: saved.dbMessage, discrepancy: extra.calendarDiscrepancy || null })
      return apiError(saved.code, extra)
    }

    return Response.json({ ok: true })
  } catch (err) {
    return Response.json({ error: err.message || 'Error inesperado.' }, { status: 500 })
  }
}
