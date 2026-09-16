// app/api/services/cancel/route.js
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { deleteEvent } from '@/lib/googleCalendar'

export async function POST(request) {
  try {
    const authHeader = request.headers.get('authorization') || ''
    const token = authHeader.replace('Bearer ', '')
    if (!token) return Response.json({ error: 'No autorizado.' }, { status: 401 })
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token)
    if (userError || !userData?.user) return Response.json({ error: 'Sesión inválida.' }, { status: 401 })

    const { serviceId } = await request.json()
    const { data: service, error: svcError } = await supabaseAdmin.from('services').select('*').eq('id', serviceId).single()
    if (svcError || !service) return Response.json({ error: 'No se encontró el servicio.' }, { status: 404 })

    if (service.google_event_id && service.calendar_owner) {
      try { await deleteEvent(service.calendar_owner, service.google_event_id) }
      catch (e) { /* si falla borrar el evento, igual cancelamos el servicio localmente */ }
    }

    await supabaseAdmin.from('services').update({
      status: 'cancelado',
      google_event_id: null,
      google_event_link: null,
      sync_status: 'no_agendado',
      sync_error: null,
      updated_at: new Date().toISOString(),
    }).eq('id', serviceId)

    return Response.json({ ok: true })
  } catch (err) {
    return Response.json({ error: err.message || 'Error inesperado.' }, { status: 500 })
  }
}
