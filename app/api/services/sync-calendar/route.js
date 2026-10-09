// app/api/services/sync-calendar/route.js
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { createEvent, updateEvent, deleteEvent } from '@/lib/googleCalendar'
import { apiError, loadQuoteForGuard, guardOperation, updateFailure, logApi } from '@/lib/serviceApiGuard'

function buildDescription({ client, quote, service }) {
  const lines = [
    `Cliente: ${client?.name || quote?.client_name || ''}`,
    `Teléfono: ${client?.phone || quote?.client_phone || ''}`,
    `Correo: ${client?.email || quote?.client_email || ''}`,
    `Dirección: ${service.address || ''}`,
    `Cotización: #${quote?.folio || ''}`,
    `Servicio: ${service.service_type || ''}`,
  ]
  if (service.notes) lines.push('', `Notas: ${service.notes}`)
  return lines.join('\n')
}

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

    // Fase 6.7C-1.3c / Etapa 2 — la contratación real (service.quote_id leído de la base, nunca un id del navegador)
    // se consulta ANTES de tocar Google Calendar. Cancelada o no verificable => se rechaza sin ningún efecto externo.
    const { quote, unverified } = await loadQuoteForGuard(supabaseAdmin, service.quote_id, 'id, status, lifecycle_status, folio, client_name, client_phone, client_email')
    if (unverified) return apiError('CONTRACT_UNVERIFIED')
    const blocked = guardOperation('sync', service, quote)
    if (blocked) return apiError(blocked)

    if (!service.start_at) {
      return Response.json({ error: 'Este servicio todavía no tiene fecha y hora — no hay nada que sincronizar aún.' }, { status: 422 })
    }

    const { data: client } = service.client_id
      ? await supabaseAdmin.from('clients').select('name, phone, email').eq('id', service.client_id).single()
      : { data: null }

    const title = `${service.service_type || 'Servicio'} - ${client?.name || quote?.client_name || 'Cliente'}`
    const description = buildDescription({ client, quote, service })
    // El evento vive en el calendario de quien lo creó originalmente
    // (calendar_owner), no de quien esté editando ahora — así nunca se crea
    // un segundo evento en otro calendario al reprogramar.
    const calendarOwner = service.calendar_owner || userData.user.id
    const hadEvent = Boolean(service.google_event_id)
    const eventData = { title, description, startAt: service.start_at, durationMinutes: service.duration_minutes, location: service.address }

    let result
    try {
      result = hadEvent
        ? await updateEvent(calendarOwner, service.google_event_id, eventData)
        : await createEvent(calendarOwner, eventData)
    } catch (calErr) {
      // El servicio ya existe en la base de datos aunque esto falle — nunca
      // se pierde, solo queda marcado para reintentar.
      const marked = updateFailure(await supabaseAdmin.from('services').update({
        sync_status: 'error',
        sync_error: calErr.message,
        updated_at: new Date().toISOString(),
      }).eq('id', serviceId).select('id'))
      if (marked) {
        logApi('sync-calendar', { serviceId, apiCode: marked.code, dbCode: marked.dbCode, dbMessage: marked.dbMessage, detail: 'falló Calendar y tampoco se pudo guardar el estado de error' })
        // Si la base lo rechazó porque la contratación se canceló en el intervalo, esa es la respuesta correcta.
        if (marked.code === 'CONTRACT_CANCELLED' || marked.code === 'CONTRACT_UNVERIFIED' || marked.code === 'CONCURRENT_OPERATION') return apiError(marked.code)
      }
      return Response.json({ error: calErr.message, code: 'CALENDAR_ERROR' }, { status: 502 })
    }

    const saved = updateFailure(await supabaseAdmin.from('services').update({
      google_event_id: result.eventId,
      google_event_link: result.eventLink,
      calendar_owner: calendarOwner,
      sync_status: 'sincronizado',
      sync_error: null,
      updated_at: new Date().toISOString(),
    }).eq('id', serviceId).select('id'))

    if (saved) {
      // Google ya se modificó pero la base NO quedó actualizada. Nunca se responde éxito.
      const extra = {}
      let compensation = 'none'
      if (!hadEvent) {
        // Evento recién creado por ESTA petición: se intenta retirar (solo ése; jamás un evento preexistente).
        try { await deleteEvent(calendarOwner, result.eventId); compensation = 'removed'; extra.calendarCompensated = true }
        catch { compensation = 'failed'; extra.calendarDiscrepancy = 'event_orphaned' }
      } else {
        // Se modificó un evento YA existente: no se borra ni se afirma que se revirtió.
        compensation = 'not_applicable'; extra.calendarDiscrepancy = 'event_modified'
      }
      logApi('sync-calendar', { serviceId, eventId: result.eventId, apiCode: saved.code, dbCode: saved.dbCode, dbMessage: saved.dbMessage, compensation, discrepancy: extra.calendarDiscrepancy || null })
      return apiError(saved.code, extra)
    }

    return Response.json({ ok: true, eventLink: result.eventLink })
  } catch (err) {
    return Response.json({ error: err.message || 'Error inesperado.' }, { status: 500 })
  }
}
