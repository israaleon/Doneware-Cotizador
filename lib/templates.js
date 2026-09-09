// lib/templates.js
import { fmt } from './calc'

// rec viene de la tabla `quotes` (columnas snake_case), config viene de `app_config`
export function fillTemplate(str, rec, config) {
  const tipoLower = rec.status === 'recibo' ? 'recibo' : 'cotización'
  const tipoCap = rec.status === 'recibo' ? 'Recibo' : 'Cotización'
  const map = {
    '{cliente}': rec.client_name || 'cliente',
    '{empresa}': config.company_name || '',
    '{folio}': rec.folio,
    '{tipo}': tipoLower,
    '{Tipo}': tipoCap,
    '{total}': fmt(rec.total),
    '{vigencia}': (rec.valid_days || config.valid_days) + ' días',
    '{telefono_empresa}': config.phone || '',
    '{referencia}': rec.related_folio || '',
  }
  let out = str || ''
  Object.keys(map).forEach((k) => {
    out = out.split(k).join(map[k])
  })
  return out
}
