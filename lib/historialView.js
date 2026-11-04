// lib/historialView.js — N3-B (ronda Donnie): lógica PURA de la vista «Mis cotizaciones» (sin React, sin red, sin datos).
// Aquí viven: paginación (página válida, rangos, números con puntos suspensivos), filtros (los de siempre + estado comercial con los estados REALES),
// conteos veraces y la decisión de qué acción es la principal de cada registro y cuáles van en «⋯».
// No contiene reglas de negocio nuevas: las condiciones de cada acción son las que ya tenía app/historial/page.js (lib/quoteLifecycle.js,
// lib/quoteServiceView.js); aquí solo se ordenan para presentarlas. Los manejadores (editar, PDF, envíos, contratar, cancelar, eliminar…) siguen en la página.
import { isContracted, isCancelled, canContractQuote, canCancelContract, canDeleteQuote } from './quoteLifecycle'
import { serviceActionLabel } from './quoteServiceView'

// ---------- Paginación ----------
export const PAGE_SIZES = [10, 20, 50]
export const DEFAULT_PAGE_SIZE = 20

export const totalPages = (total, size) => Math.max(1, Math.ceil(Math.max(0, Number(total) || 0) / Math.max(1, Number(size) || DEFAULT_PAGE_SIZE)))

// Página válida: entera, ≥ 1 y ≤ total de páginas (p. ej. tras filtrar, eliminar el último registro de la última página o cambiar el tamaño de página).
export function clampPage(page, pages) {
  const p = Number.isFinite(Number(page)) ? Math.floor(Number(page)) : 1
  return Math.min(Math.max(1, p), Math.max(1, pages))
}

// Rango visible «a–b de N» (0–0 si no hay registros).
export function pageRange(page, size, total) {
  if (!total) return { from: 0, to: 0 }
  return { from: (page - 1) * size + 1, to: Math.min(total, page * size) }
}

// Números de página a mostrar: todos si caben; si no, primera, última y vecinas de la actual con «…».
export function pageWindow(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  const set = new Set([1, pages, page - 1, page, page + 1])
  if (page <= 3) { set.add(2); set.add(3); set.add(4) }
  if (page >= pages - 2) { set.add(pages - 1); set.add(pages - 2); set.add(pages - 3) }
  const nums = [...set].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b)
  const out = []
  nums.forEach((n, i) => { if (i && n - nums[i - 1] > 1) out.push('…'); out.push(n) })
  return out
}

// Nombre del cliente en la lista: máximo 25 caracteres EN PANTALLA, contando la elipsis. El dato completo no se toca (se muestra en un tooltip).
export const NAME_MAX = 25
export function shortName(name) {
  const chars = Array.from(String(name == null ? '' : name))
  if (chars.length <= NAME_MAX) return chars.join('')
  return chars.slice(0, NAME_MAX - 1).join('').trimEnd() + '…'
}

// Grupo de hasta tres números de página para móvil: centrado en la actual y desplazado en los extremos (1-2-3, …, n-2-n-1-n).
export function pageWindow3(page, pages) {
  const n = Math.min(3, Math.max(1, pages))
  const start = Math.min(Math.max(1, page - 1), Math.max(1, pages) - n + 1)
  return Array.from({ length: n }, (_, i) => start + i)
}

// ---------- Estados y filtros ----------
// Estado comercial REAL de una cotización (lifecycle_status), el mismo que usan lib/quoteLifecycle.js y la página de Inicio.
export function stateOf(q) {
  if (isCancelled(q)) return 'cancelado'
  if (isContracted(q)) return 'contratado'
  return 'cotizacion'
}
export const COMMERCIAL = {
  cotizacion: { label: 'En cotización', tone: 'cot' },
  // «Aceptada» = valor interno lifecycle_status 'contratado' (sin cambios). Cubre la aceptación pública del cliente Y el registro manual del personal; el texto no atribuye un método.
  contratado: { label: 'Aceptada', tone: 'rec', hint: 'La cotización fue aceptada (por el cliente en línea o registrada manualmente por el personal)' },
  cancelado: { label: 'Cancelada', tone: 'can' },
}
export const STATE_FILTERS = [
  { value: 'all', label: 'Todas' },
  { value: 'cotizacion', label: 'En cotización' },
  { value: 'contratado', label: 'Aceptadas' }, // valor interno intacto: lifecycle_status 'contratado'
  { value: 'cancelado', label: 'Canceladas' },
]
export const TYPE_FILTERS = [
  { value: 'all', label: 'Todo' },
  { value: 'cotizacion', label: 'Cotizaciones' },
  { value: 'recibo', label: 'Recibos' },
]

// recibo (status='recibo') → por su cotización (related_folio) si esa cotización existe; si no, queda como registro independiente.
export function buildReceiptsByFolio(quotes) {
  const cotFolios = new Set(quotes.filter((q) => q.status !== 'recibo').map((q) => q.folio))
  const map = {}
  quotes.forEach((q) => {
    if (q.status === 'recibo' && q.related_folio && cotFolios.has(q.related_folio)) (map[q.related_folio] ||= []).push(q)
  })
  return map
}

// Filtros ANTES de paginar. Mantiene la semántica de siempre (texto por cliente o folio, fecha, tipo; los recibos asociados viajan con su cotización y
// no se cuentan como registros aparte) y agrega el estado comercial: solo aplica a cotizaciones; un recibo suelto no tiene estado comercial y queda
// fuera cuando se filtra por estado.
export function filterRecords({ quotes, receiptsByFolio, text = '', date = '', type = 'all', state = 'all' }) {
  const needle = String(text).trim().toLowerCase()
  const matches = (q) => {
    if (needle && !`${q.client_name || ''} ${q.folio || ''}`.toLowerCase().includes(needle)) return false
    if (date && new Date(q.created_at).toISOString().slice(0, 10) !== date) return false
    return true
  }
  return quotes.filter((q) => {
    const isReceipt = q.status === 'recibo'
    if (isReceipt && q.related_folio && receiptsByFolio[q.related_folio]) return false // va dentro de su cotización
    const children = isReceipt ? [] : (receiptsByFolio[q.folio] || [])
    if (type === 'cotizacion' && isReceipt) return false
    if (type === 'recibo' && !isReceipt && !children.length) return false
    if (state !== 'all') {
      if (isReceipt) return false
      if (stateOf(q) !== state) return false
    }
    return matches(q) || children.some(matches)
  })
}

// ---------- Acciones por registro ----------
const ORDER = ['edit', 'pdf', 'send', 'link', 'service', 'cancel', 'delete']

// Devuelve { primary | null, secondary[] }; cada acción: { key, label, tone?, danger? }. Las claves las resuelve la página con SUS manejadores de siempre:
//   pdf → downloadPdf · send → (email → sendByEmail · whatsapp → sendByWhatsapp) · link → Gestionar enlace · edit → /cotizar?edit= · accept → contractQuote
//   cancel → cancelContract · service → /servicios… · delete → deleteRecord
// Las condiciones son exactamente las del Historial anterior; solo cambia dónde se muestran (una principal + «⋯»).
//   isChild = recibo mostrado dentro de su cotización · serviceView = resolveQuoteServiceView (null para recibos) · caps.manageLink = canManageLink(q) y capacidad habilitada
export function recordActions({ q, isChild = false, serviceView = null, caps = {} }) {
  const isReceipt = q.status === 'recibo'
  const all = [
    { key: 'pdf', label: 'Descargar PDF' },
    // «Enviar a…» abre un segundo paso con Correo y WhatsApp (igual que el «Enviar a ▾» de antes): el enlace {link} se prepara solo al entrar a ese paso.
    { key: 'send', label: 'Enviar a…', children: [{ key: 'email', label: 'Correo' }, { key: 'whatsapp', label: 'WhatsApp' }] },
  ]
  if (!isReceipt && !isChild && caps.manageLink) all.push({ key: 'link', label: 'Gestionar enlace' })
  if (!isReceipt && canContractQuote(q)) {
    all.push({ key: 'edit', label: 'Editar' })
    all.push({ key: 'accept', label: 'Registrar aceptación', tone: 'primary' }) // misma contratación manual y auditoría (contractQuote); solo cambia el texto
  }
  if (!isReceipt && canCancelContract(q)) all.push({ key: 'cancel', label: 'Cancelar contratación', danger: true })
  if (serviceView && serviceView.action && serviceView.action.kind !== 'none') {
    all.push({ key: 'service', label: serviceActionLabel(serviceView.action), tone: serviceView.action.kind === 'schedule_existing' ? 'accent' : 'ghost' })
  }
  if (!isChild && canDeleteQuote(q)) all.push({ key: 'delete', label: 'Eliminar', danger: true })
  // Acción principal = la comercial (aceptación manual o servicio). «Descargar PDF» va SIEMPRE en «⋯». Sin acción comercial (recibos, contratadas sin servicio,
  // canceladas) no hay botón principal: solo «⋯». El pago de un recibo pertenece a N5 Pagos y NO se ofrece aquí.
  const primary = all.find((a) => a.key === 'accept') || all.find((a) => a.key === 'service') || null
  const secondary = all.filter((a) => a !== primary).sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key))
  return { primary: primary ? { tone: 'ghost', ...primary } : null, secondary }
}
