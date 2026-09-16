// app/api/services/sync-calendar/route.js
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { createEvent, updateEvent } from '@/lib/googleCalendar'

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

    if (!service.start_at) {
      return Response.json({ error: 'Este servicio todavía no tiene fecha y hora — no hay nada que sincronizar aún.' }, { status: 422 })
    }

    const [{ data: quote }, { data: client }] = await Promise.all([
      supabaseAdmin.from('quotes').select('folio, client_name, client_phone, client_email').eq('id', service.quote_id).single(),
      service.client_id ? supabaseAdmin.from('clients').select('name, phone, email').eq('id', service.client_id).single() : { data: null },
    ])

    const title = `${service.service_type || 'Servicio'} - ${client?.name || quote?.client_name || 'Cliente'}`
    const description = buildDescription({ client, quote, service })
    // El evento vive en el calendario de quien lo creó originalmente
    // (calendar_owner), no de quien esté editando ahora — así nunca se crea
    // un segundo evento en otro calendario al reprogramar.
    const calendarOwner = service.calendar_owner || userData.user.id

    try {
      let result
      if (service.google_event_id) {
        result = await updateEvent(calendarOwner, service.google_event_id, {
          title, description, startAt: service.start_at, durationMinutes: service.duration_minutes, location: service.address,
        })
      } else {
        result = await createEvent(calendarOwner, {
          title, description, startAt: service.start_at, durationMinutes: service.duration_minutes, location: service.address,
        })
      }

      await supabaseAdmin.from('services').update({
        google_event_id: result.eventId,
        google_event_link: result.eventLink,
        calendar_owner: calendarOwner,
        sync_status: 'sincronizado',
        sync_error: null,
        updated_at: new Date().toISOString(),
      }).eq('id', serviceId)

      return Response.json({ ok: true, eventLink: result.eventLink })
    } catch (calErr) {
      // El servicio ya existe en la base de datos aunque esto falle — nunca
      // se pierde, solo queda marcado para reintentar.
      await supabaseAdmin.from('services').update({
        sync_status: 'error',
        sync_error: calErr.message,
        updated_at: new Date().toISOString(),
      }).eq('id', serviceId)
      return Response.json({ error: calErr.message }, { status: 502 })
    }
  } catch (err) {
    return Response.json({ error: err.message || 'Error inesperado.' }, { status: 500 })
  }
}
