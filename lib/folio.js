// lib/folio.js
import { supabase } from './supabaseClient'

// El folio siguiente se calcula a partir del máximo folio existente de ese
// tipo y año, en vez de depender de un contador guardado en app_config.
// Ventaja: si borras el último registro de un tipo, el siguiente que crees
// reutiliza ese número automáticamente — sin contadores que se puedan
// desincronizar entre cotizaciones y recibos (que era justo el bug).
export async function nextFolio(status) {
  const year = new Date().getFullYear()
  const prefix = status === 'recibo' ? 'REC' : 'COT'
  const likePattern = `${prefix}-${year}-%`

  const { data, error } = await supabase
    .from('quotes')
    .select('folio')
    .eq('status', status)
    .like('folio', likePattern)
    .order('folio', { ascending: false })
    .limit(1)

  let n = 1
  if (!error && data && data.length) {
    const match = data[0].folio.match(/-(\d+)$/)
    if (match) n = parseInt(match[1], 10) + 1
  }
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`
}
