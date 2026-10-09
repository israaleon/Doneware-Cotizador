// lib/serviceGuard.js
// Fase 6.7C-1.3c / Etapa 1 — protección de INTERFAZ para servicios de contrataciones canceladas.
//
// Regla: si quotes.lifecycle_status === 'cancelado', los servicios de esa cotización son de SOLO LECTURA,
// sea cual sea su propio status. La autoridad es la cotización, no services.status ni quotes.contracted
// (esta última es histórica: no vuelve a false al cancelar).
//
// IMPORTANTE: esto es una protección de pantalla y de comprobación previa. NO es definitiva ante una
// cancelación concurrente (la cotización puede cancelarse entre la comprobación y la escritura); esa
// garantía llega con las Etapas 2 (API) y 3 (trigger de PostgreSQL).
//
// Solo lectura: las funciones que reciben `client` solo hacen SELECT.
import { parseQuoteIdParam } from './serviceListFilter'

export const CANCELLED_NOTICE = 'Contratación cancelada. Este servicio está disponible únicamente para consulta.'
export const UNVERIFIED_NOTICE = 'No se pudo confirmar el estado de la contratación de este servicio. Se muestra únicamente para consulta.'

export const KNOWN_LIFECYCLE = ['cotizacion', 'contratado', 'cancelado']

export function isQuoteCancelled(quote) {
  return !!quote && quote.lifecycle_status === 'cancelado'
}

// ---------- Detalle del servicio ----------

// ctx = resultado de loadServiceContext (o null si todavía no hay respuesta para este servicio).
//   mode: 'checking' | 'service_error' | 'unverified' | 'readonly' | 'editable'
// Solo 'editable' permite escribir. Cualquier duda (cargando, error, valor desconocido) BLOQUEA.
export function resolveServiceAccess(ctx) {
  if (!ctx) return { mode: 'checking', canWrite: false }
  if (ctx.serviceError || !ctx.service) return { mode: 'service_error', canWrite: false }
  if (ctx.quoteError || !ctx.quote) return { mode: 'unverified', canWrite: false }
  if (isQuoteCancelled(ctx.quote)) return { mode: 'readonly', canWrite: false }
  if (KNOWN_LIFECYCLE.includes(ctx.quote.lifecycle_status)) return { mode: 'editable', canWrite: true }
  return { mode: 'unverified', canWrite: false }          // lifecycle_status nulo o desconocido: no se asume "activa"
}

// Mismas dos consultas que ya hacía la pantalla (servicio y su cotización), pero sin ocultar los fallos:
// un error al leer la cotización NO se interpreta como "no cancelada". Nunca lanza.
export async function loadServiceContext(client, id) {
  try {
    const { data: service, error } = await client.from('services').select('*').eq('id', id).single()
    if (error || !service) return { service: null, quote: null, serviceError: (error && error.message) || 'No se encontró el servicio.', quoteError: null }
    let quote = null
    let quoteError = null
    try {
      const r = await client.from('quotes').select('*').eq('id', service.quote_id).single()
      quote = r.data || null
      if (r.error || !r.data) quoteError = (r.error && r.error.message) || 'No se encontró la cotización.'
    } catch (e) {
      quoteError = (e && e.message) || 'Error al consultar la cotización.'
    }
    return { service, quote, serviceError: null, quoteError }
  } catch (e) {
    return { service: null, quote: null, serviceError: (e && e.message) || 'Error al consultar el servicio.', quoteError: null }
  }
}

// La cancelación de una contratación es irreversible (no existe una RPC que la revierta): si para ESTE servicio
// ya se vio la cotización cancelada, una respuesta posterior (o rezagada) que la muestre activa o con error
// NO vuelve a habilitar los controles.
export function mergeServiceContext(prev, next) {
  if (prev && prev.service && next && next.service && prev.service.id === next.service.id && isQuoteCancelled(prev.quote) && !isQuoteCancelled(next.quote)) {
    return { ...next, quote: prev.quote, quoteError: null }
  }
  return next
}

// Re-validación justo ANTES de escribir (la pantalla puede llevar abierta mucho tiempo).
// ok=true solo con confirmación explícita de una cotización NO cancelada y con estado conocido.
export async function verifyQuoteWritable(client, quoteId) {
  try {
    const { data, error } = await client.from('quotes').select('id, lifecycle_status').eq('id', quoteId).single()
    if (error || !data) return { ok: false, reason: 'unverified', message: UNVERIFIED_NOTICE }
    if (isQuoteCancelled(data)) return { ok: false, reason: 'cancelled', message: CANCELLED_NOTICE }
    if (!KNOWN_LIFECYCLE.includes(data.lifecycle_status)) return { ok: false, reason: 'unverified', message: UNVERIFIED_NOTICE }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'unverified', message: UNVERIFIED_NOTICE }
  }
}

// ---------- Nuevo servicio ----------

// ¿Puede una cotización recibir un servicio NUEVO? Solo una cotización documental con contratación VIGENTE.
export function validateQuoteForNewService(quote) {
  if (!quote) return { ok: false, code: 'not_found', message: 'No se encontró la cotización.' }
  if (quote.status === 'recibo') return { ok: false, code: 'receipt', message: 'Este registro es un recibo. Los servicios se asocian a la cotización contratada, no al recibo.' }
  if (quote.status !== 'cotizacion') return { ok: false, code: 'not_quote', message: 'Este registro no es una cotización.' }
  if (quote.lifecycle_status === 'cancelado') return { ok: false, code: 'cancelled', message: 'La contratación de esta cotización fue cancelada. Ya no se pueden agendar servicios para ella.' }
  if (quote.lifecycle_status === 'cotizacion') return { ok: false, code: 'not_contracted', message: 'Esta cotización todavía no está contratada. Contrátala desde Historial para poder agendar un servicio.' }
  if (quote.lifecycle_status === 'contratado') return { ok: true }
  return { ok: false, code: 'unknown', message: 'No se pudo confirmar el estado de la contratación de esta cotización.' }
}

// Re-validación justo ANTES de insertar un servicio nuevo (la cotización pudo cancelarse con la pantalla abierta).
export async function verifyQuoteForNewService(client, quoteId) {
  try {
    const { data, error } = await client.from('quotes').select('id, status, lifecycle_status').eq('id', quoteId).single()
    if (error || !data) return { ok: false, code: 'unverified', message: 'No se pudo confirmar el estado de la contratación de esta cotización. No se creó el servicio.' }
    return validateQuoteForNewService(data)
  } catch {
    return { ok: false, code: 'unverified', message: 'No se pudo confirmar el estado de la contratación de esta cotización. No se creó el servicio.' }
  }
}

// Resuelve qué muestra /servicios/nuevo. Nunca lanza.
//   rawQuoteId = searchParams.get('quoteId') (null si no existe)
//   { kind: 'picklist', quotes }   sin quoteId: cotizaciones contratadas (vigentes) que aún no tienen servicio
//   { kind: 'form', quote }        quoteId válido, existente y contratado
//   { kind: 'blocked', message }   quoteId inválido / inexistente / recibo / cancelada / precontractual
//   { kind: 'error', message }     falló la consulta (no se asume nada)
export async function loadNewServiceTarget(client, rawQuoteId) {
  const parsed = parseQuoteIdParam(rawQuoteId)
  if (parsed.state === 'invalid') return { kind: 'blocked', code: 'invalid', message: 'El identificador de cotización no es válido.' }

  if (parsed.state === 'valid') {
    try {
      const { data, error } = await client.from('quotes').select('*').eq('id', parsed.quoteId).single()
      if (error && error.code !== 'PGRST116') return { kind: 'error', message: 'No se pudo consultar la cotización. Intenta de nuevo.' }
      const v = validateQuoteForNewService(data || null)
      if (!v.ok) return { kind: 'blocked', code: v.code, message: v.message }
      return { kind: 'form', quote: data }
    } catch {
      return { kind: 'error', message: 'No se pudo consultar la cotización. Intenta de nuevo.' }
    }
  }

  try {
    const [q, s] = await Promise.all([
      client.from('quotes').select('*').eq('status', 'cotizacion').eq('lifecycle_status', 'contratado'),
      client.from('services').select('quote_id'),
    ])
    if (q.error || s.error) return { kind: 'error', message: 'No se pudieron consultar las cotizaciones. Intenta de nuevo.' }
    const withService = new Set((s.data || []).map((x) => x.quote_id))
    // Defensa extra en el cliente: aunque la consulta ya filtra, solo se listan las que validate acepta.
    return { kind: 'picklist', quotes: (q.data || []).filter((x) => !withService.has(x.id) && validateQuoteForNewService(x).ok) }
  } catch {
    return { kind: 'error', message: 'No se pudieron consultar las cotizaciones. Intenta de nuevo.' }
  }
}
