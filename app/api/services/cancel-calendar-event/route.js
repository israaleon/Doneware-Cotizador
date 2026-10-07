// app/api/services/cancel-calendar-event/route.js
// Fase 6.6B — limpieza best-effort de UN evento de Google Calendar después de
// que cancel_quote_contract ya hizo commit en DB. A propósito NO toca la
// tabla `services` en absoluto (ni status ni google_event_id/link): esa
// transición contractual ya es responsabilidad exclusiva de la RPC, que
// deliberadamente conserva google_event_id para diagnóstico/reintento futuro
// (Fase 6.6, punto 18) — a diferencia de /api/services/cancel, que sí lo
// limpia porque resuelve un caso distinto (cancelar un servicio suelto, no
// contractual).
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
    const { data: service, error: svcError } = await supabaseAdmin
      .from('services').select('google_event_id, calendar_owner').eq('id', serviceId).single()
    if (svcError || !service) return Response.json({ error: 'No se encontró el servicio.' }, { status: 404 })

    if (!service.google_event_id || !service.calendar_owner) {
      return Response.json({ ok: true, skipped: true })
    }
    await deleteEvent(service.calendar_owner, service.google_event_id)
    return Response.json({ ok: true })
  } catch (err) {
    return Response.json({ error: err.message || 'Error inesperado.' }, { status: 500 })
  }
}
