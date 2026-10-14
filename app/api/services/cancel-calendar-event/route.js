// app/api/services/cancel-calendar-event/route.js
// Fase 6.6B — limpieza best-effort de UN evento de Google Calendar después de
// que cancel_quote_contract ya hizo commit en DB. A propósito NO toca la
// tabla `services` en absoluto (ni status ni google_event_id/link): esa
// transición contractual ya es responsabilidad exclusiva de la RPC, que
// deliberadamente conserva google_event_id para diagnóstico/reintento futuro
// (Fase 6.6, punto 18) — a diferencia de /api/services/cancel, que sí lo
// limpia porque resuelve un caso distinto (cancelar un servicio suelto, no
// contractual).
//
// Fase B / D-02 — antes de tocar Google se verifica en la base (service.quote_id leído de la base, nunca un dato del navegador) que
// la limpieza procede: contratación CANCELADA y servicio CANCELADO (justo como los deja cancel_quote_contract). Un servicio vigente
// o realizado conserva su evento. Cualquier duda (cotización ilegible, estado desconocido) rechaza SIN borrar nada.
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { deleteEvent } from '@/lib/googleCalendar'
import { apiError, loadQuoteForGuard, guardOperation } from '@/lib/serviceApiGuard'

export async function POST(request) {
  try {
    const authHeader = request.headers.get('authorization') || ''
    const token = authHeader.replace('Bearer ', '')
    if (!token) return Response.json({ error: 'No autorizado.' }, { status: 401 })
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token)
    if (userError || !userData?.user) return Response.json({ error: 'Sesión inválida.' }, { status: 401 })

    const { serviceId } = await request.json()
    const { data: service, error: svcError } = await supabaseAdmin
      .from('services').select('google_event_id, calendar_owner, status, quote_id').eq('id', serviceId).single()
    if (svcError || !service) return Response.json({ error: 'No se encontró el servicio.' }, { status: 404 })

    const { quote, unverified } = await loadQuoteForGuard(supabaseAdmin, service.quote_id)
    if (unverified) return apiError('CONTRACT_UNVERIFIED')
    const blocked = guardOperation('calendar_cleanup', service, quote)
    if (blocked) return apiError(blocked)

    if (!service.google_event_id) {
      return Response.json({ ok: true, skipped: true })
    }
    // Hay referencia a un evento pero no se sabe en qué calendario está: no se puede borrar ni verificar. Nunca se responde éxito.
    if (!service.calendar_owner) return apiError('CALENDAR_OWNER_MISSING')
    // 'deleted' | 'already_gone' (Google confirmó 404/410). Si Google falla, deleteEvent lanza y no se escribe nada en la base.
    const calendar = await deleteEvent(service.calendar_owner, service.google_event_id)
    return Response.json({ ok: true, calendar })
  } catch (err) {
    return Response.json({ error: err.message || 'Error inesperado.' }, { status: 500 })
  }
}
