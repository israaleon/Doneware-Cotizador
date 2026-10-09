// lib/quoteServiceView.js
// Fase 6.7C-1.3 — qué muestra Historial para una COTIZACIÓN según su estado
// comercial (lifecycle_status) y el estado operativo de su servicio.
//
// Función PURA: solo decide etiquetas y acción; no consulta ni escribe nada
// (ni quotes, ni services, ni contract_quote). La navegación a Servicios se
// resuelve con serviceActionHref y siempre reutiliza pantallas existentes.
//
// Estado COMERCIAL (lifecycle_status): 'Contratada' se muestra siempre que
// la cotización esté contratada, sin importar el servicio.
// Estado OPERATIVO (services.status, valores reales de lib/serviceStatus.js):
// se muestra junto a la anterior cuando existe un servicio. Que exista un
// registro de servicio NO significa que esté agendado: manda services.status.
import { isContracted, isCancelled } from './quoteLifecycle'
import { SERVICE_STATUS_LABEL, SERVICE_STATUS_BADGE } from './serviceStatus'

// services -> Map(quote_id -> [servicio, ...]) en el orden recibido.
export function groupServicesByQuote(services) {
  const map = new Map()
  for (const s of services || []) {
    const list = map.get(s.quote_id)
    if (list) list.push(s)
    else map.set(s.quote_id, [s])
  }
  return map
}

// quote: fila de quotes con status='cotizacion' (los recibos no usan esto).
// quoteServices: servicios de esa cotización (puede ser undefined/[]).
//
// Devuelve { badges: [{ text, tone }], action }, con action:
//   { kind: 'none' }                          sin acción
//   { kind: 'schedule_existing', serviceId }  UN servicio pendiente de agendar -> "Agendar servicio"
//   { kind: 'view', serviceId }               UN servicio en otro estado -> "Ver servicio"
//   { kind: 'view_many', quoteId }            VARIOS servicios -> "Ver servicios" (/servicios?quoteId=<quotes.id>)
export function resolveQuoteServiceView(quote, quoteServices) {
  const list = quoteServices || []
  const count = list.length
  const manyAction = quote && quote.id ? { kind: 'view_many', quoteId: quote.id } : { kind: 'none' }
  // Solo con EXACTAMENTE un servicio hay un servicio inequívoco. Con varios no
  // se elige ninguno (ni su estado ni su id): se envía a la lista de Servicios.
  const service = count === 1 ? list[0] : null

  if (isCancelled(quote)) {
    const action = count === 0 ? { kind: 'none' } : service ? { kind: 'view', serviceId: service.id } : manyAction
    return { badges: [{ text: 'CANCELADO', tone: 'can' }], action }
  }

  if (!isContracted(quote)) {
    return { badges: [{ text: 'COTIZACIÓN', tone: 'cot' }], action: { kind: 'none' } }
  }

  const badges = [{ text: 'Contratada', tone: 'rec' }]
  // Contratada sin servicio: no se crea ni se ofrece crear uno desde Historial
  // (/servicios/nuevo podría duplicarlo). Solo la etiqueta, sin acción.
  if (count === 0) return { badges, action: { kind: 'none' } }
  // Varios servicios: ningún estado operativo (podría leerse como el de todos).
  if (!service) return { badges, action: manyAction }

  const label = SERVICE_STATUS_LABEL[service.status]
  if (label) badges.push({ text: label, tone: SERVICE_STATUS_BADGE[service.status] })

  if (service.status === 'pendiente_agendar') {
    return { badges, action: { kind: 'schedule_existing', serviceId: service.id } }
  }
  return { badges, action: { kind: 'view', serviceId: service.id } }
}

export function serviceActionLabel(action) {
  if (action.kind === 'schedule_existing') return 'Agendar servicio'
  if (action.kind === 'view') return 'Ver servicio'
  if (action.kind === 'view_many') return 'Ver servicios'
  return null
}

// Destino de la acción. 'schedule_existing' y 'view' abren el servicio YA
// existente (/servicios/[id], donde se captura fecha y hora y se sincroniza
// Calendar). 'view_many' abre la lista /servicios filtrada por el ID de la
// cotización (quotes.id, no el folio ni el de un servicio). Nunca se navega a
// /servicios/nuevo, para no crear un servicio duplicado.
export function serviceActionHref(action) {
  if (action.kind === 'schedule_existing' || action.kind === 'view') return `/servicios/${action.serviceId}`
  if (action.kind === 'view_many') return `/servicios?quoteId=${encodeURIComponent(action.quoteId)}`
  return null
}
