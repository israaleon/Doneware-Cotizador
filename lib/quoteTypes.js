// lib/quoteTypes.js — N3-A (ronda Donnie): tipos de cotización para la pantalla de selección.
// NO es un modelo nuevo: son los valores que ya existen en quotes.quote_type y que usan el formulario (app/cotizar/page.js, QUOTE_TYPES),
// Ajustes (textos por tipo) y lib/quoteSnapshot.js (computeRequiresServiceSuggestion). Aquí solo se reutilizan para elegir el tipo ANTES de abrir el formulario.

export const QUOTE_TYPE_VALUES = ['instalacion', 'servicio', 'venta']

// Tarjetas de la pantalla de selección (texto breve; las reglas reales las sigue aplicando el formulario).
export const QUOTE_TYPE_CARDS = [
  { value: 'instalacion', label: 'Instalación', icon: 'wrench', desc: 'Equipos o sistemas que se instalan en el sitio del cliente.', note: 'Incluye servicio en sitio.' },
  { value: 'servicio', label: 'Servicios', icon: 'check', desc: 'Trabajos y servicios que se realizan para el cliente.', note: 'Incluye servicio en sitio.' },
  { value: 'venta', label: 'Venta de productos', icon: 'box', desc: 'Productos que se entregan al cliente.', note: 'El servicio es opcional: solo si agregas conceptos de servicio.' },
]

// ?tipo= llega por la URL: solo se acepta uno de los valores existentes; cualquier otro se ignora (el formulario arranca sin tipo, como siempre).
export function parseQuoteTypeParam(value) {
  return typeof value === 'string' && QUOTE_TYPE_VALUES.includes(value) ? value : ''
}

export const quoteFormHref = (type) => `/cotizar?tipo=${encodeURIComponent(type)}`
