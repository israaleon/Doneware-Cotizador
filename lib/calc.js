// lib/calc.js
// Lógica compartida por las páginas: formato de moneda, validaciones,
// cálculo de totales y generación de folios. Es el mismo comportamiento
// que tenía el prototipo cotizador.html, solo que ahora vive en un
// módulo que cualquier página puede importar.

export const fmt = (n) =>
  (Number(n) || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })

export const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim())
export const isValidPhone10 = (p) => /^\d{10}$/.test(String(p || '').replace(/\D/g, ''))

export function calcTotals(items, discountType, discountValue, applyIva, ivaRate) {
  const subtotal = items.reduce(
    (s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 0),
    0
  )
  let discount =
    discountType === 'percent'
      ? (subtotal * (Number(discountValue) || 0)) / 100
      : Number(discountValue) || 0
  discount = Math.min(Math.max(discount, 0), subtotal)
  const base = subtotal - discount
  const iva = applyIva ? (base * (Number(ivaRate) || 0)) / 100 : 0
  const total = base + iva
  return { subtotal, discount, base, iva, total }
}

// draft = { client: {name, phone, email, address}, items: [{name, price, qty}],
//           discountType, discountValue }
export function validateQuote(draft) {
  const e = { itemErrors: {} }
  if (!draft.client.name || !draft.client.name.trim()) e.name = 'Escribe el nombre del cliente.'
  if (draft.client.phone && !isValidPhone10(draft.client.phone))
    e.phone = 'El teléfono debe tener exactamente 10 dígitos (ni más, ni menos).'
  if (draft.client.email && !isValidEmail(draft.client.email))
    e.email = 'Escribe un correo válido, por ejemplo nombre@dominio.com.'
  if (!draft.items.length) e.items = 'Agrega al menos un producto o servicio.'

  draft.items.forEach((it, idx) => {
    const ie = {}
    if (!it.name || !String(it.name).trim()) ie.name = 'Falta la descripción.'
    const priceNum = Number(it.price)
    if (it.price === '' || it.price === null || isNaN(priceNum) || priceNum < 0)
      ie.price = 'Precio inválido.'
    const qtyNum = Number(it.qty)
    if (it.qty === '' || it.qty === null || !Number.isInteger(qtyNum) || qtyNum < 1)
      ie.qty = 'Debe ser un entero ≥ 1.'
    if (Object.keys(ie).length) e.itemErrors[idx] = ie
  })
  if (!e.items && Object.keys(e.itemErrors).length) e.items = 'Revisa los productos marcados en rojo.'

  const discNum = Number(draft.discountValue)
  if (draft.discountValue !== '' && (isNaN(discNum) || discNum < 0)) e.discount = 'El descuento no puede ser negativo.'
  else if (draft.discountType === 'percent' && discNum > 100) e.discount = 'El porcentaje no puede ser mayor a 100.'

  const hasErrors = !!(e.name || e.phone || e.email || e.items || e.discount || Object.keys(e.itemErrors).length)
  return { errors: e, hasErrors }
}

export function makeFolio(type, config) {
  const year = new Date().getFullYear()
  const n = type === 'cotizacion' ? config.next_quote_number : config.next_receipt_number
  const prefix = type === 'cotizacion' ? 'COT' : 'REC'
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`
}
