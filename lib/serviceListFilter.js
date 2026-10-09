// lib/serviceListFilter.js
// Fase 6.7C-1.3b — filtro OPCIONAL por cotización en /servicios (?quoteId=<uuid>).
//
// Solo lectura: la carga es un SELECT; el filtro de la URL es una herramienta
// de navegación, NO de autorización (RLS sigue decidiendo qué filas se ven).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// raw = searchParams.get('quoteId') (null si el parámetro no existe).
//   null            -> { state: 'none' }                    listado general
//   uuid válido     -> { state: 'valid', quoteId }          (en minúsculas)
//   cualquier otra  -> { state: 'invalid' }                 (incluye '' y texto libre)
export function parseQuoteIdParam(raw) {
  if (raw === null || raw === undefined) return { state: 'none' }
  const value = String(raw).trim()
  if (!UUID_RE.test(value)) return { state: 'invalid' }
  return { state: 'valid', quoteId: value.toLowerCase() }
}

// Clave de la carga: 'all' (general), el uuid (filtrado) o null (inválido: no se consulta).
export function filterKeyOf(filter) {
  if (filter.state === 'none') return 'all'
  if (filter.state === 'valid') return filter.quoteId
  return null
}

// Misma consulta que ya usaba /servicios; solo agrega .eq('quote_id', …) cuando
// hay filtro, de modo que el filtro se aplica en Supabase y no depende de
// traer todos los servicios. Devuelve { services, error } (nunca lanza).
export async function loadServicesForList(client, filterKey) {
  if (filterKey === null) return { services: [], error: null } // inválido: sin consulta
  let query = client
    .from('services')
    .select('*, quotes(folio, client_name, client_phone, lifecycle_status)')
    .order('start_at', { ascending: true, nullsFirst: false })
  if (filterKey !== 'all') query = query.eq('quote_id', filterKey)
  try {
    const { data, error } = await query
    return { services: data || [], error: error || null }
  } catch (e) {
    return { services: [], error: e }
  }
}

// Qué debe pintar la pantalla. `loaded` = { key, services, error } de la última
// carga terminada (o null). Una carga de OTRA clave (URL anterior) nunca se
// muestra: se considera 'loading'.
//   { kind: 'invalid' }                  uuid inválido
//   { kind: 'loading', services: [] }    sin carga de la clave actual
//   { kind: 'error' }                    falló la carga filtrada (no se muestra como "vacío")
//   { kind: 'ready', services }          servicios (en modo filtrado, solo de esa cotización)
export function resolveServicesListState(filter, loaded) {
  const key = filterKeyOf(filter)
  if (key === null) return { kind: 'invalid' }
  if (!loaded || loaded.key !== key) return { kind: 'loading', services: [] }
  // El modo general conserva su comportamiento previo: un error se trataba como lista vacía.
  if (loaded.error && key !== 'all') return { kind: 'error' }
  const services = loaded.error ? [] : loaded.services || []
  // Defensa extra en el cliente: igualdad exacta de quote_id aunque llegara otra fila.
  return { kind: 'ready', services: key === 'all' ? services : services.filter((s) => String(s.quote_id).toLowerCase() === key) }
}

// Búsqueda por texto y por estado (misma lógica que ya tenía /servicios) sobre
// el conjunto YA resuelto (general o de una cotización).
export function filterServicesForList(services, { searchText = '', statusFilter = 'all' } = {}) {
  const text = searchText.trim().toLowerCase()
  return services.filter((s) => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false
    if (text) {
      const haystack = `${s.quotes?.client_name || ''} ${s.service_type || ''} ${s.quotes?.folio || ''}`.toLowerCase()
      if (!haystack.includes(text)) return false
    }
    return true
  })
}
