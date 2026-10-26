// lib/templates.js
import { fmt } from './calc'

export const LINK_PLACEHOLDER = '{link}'

// ¿Alguna de estas plantillas usa {link}? (para no pedir el enlace si no hace falta)
export function templatesUseLink(...templates) {
  return templates.some((t) => typeof t === 'string' && t.includes(LINK_PLACEHOLDER))
}

// Sin enlace (cotización antigua/legacy/sin publicar, contratada, recibo, o no se pudo obtener): se OMITE la línea completa donde
// aparece {link} — así no queda texto suelto del estilo «Revísala y acéptala aquí:» sin dirección — y se colapsan los saltos de
// línea sobrantes. Las plantillas sin {link} no se tocan.
function dropLinkLines(str) {
  if (!str.includes(LINK_PLACEHOLDER)) return str
  const kept = str.replace(/\r\n/g, '\n').split('\n').filter((line) => !line.includes(LINK_PLACEHOLDER))
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, () => (str.endsWith('\n') ? '\n' : ''))
}

// rec viene de la tabla `quotes` (columnas snake_case), config viene de `app_config`.
// extras.link (opcional): enlace público de aceptación YA resuelto por el llamador; vacío/ausente → se omite la línea de {link}.
export function fillTemplate(str, rec, config, extras = {}) {
  const tipoLower = rec.status === 'recibo' ? 'recibo' : 'cotización'
  const tipoCap = rec.status === 'recibo' ? 'Recibo' : 'Cotización'
  const link = typeof extras.link === 'string' ? extras.link : ''
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
  if (!link) out = dropLinkLines(out)
  Object.keys(map).forEach((k) => {
    out = out.split(k).join(map[k])
  })
  // {link} al final: el enlace se inserta tal cual (nunca se interpreta como plantilla ni se mezcla con los demás valores).
  if (link) out = out.split(LINK_PLACEHOLDER).join(link)
  return out
}
