// lib/quoteTypeChange.js — N3-C (ronda Donnie): efectos de cambiar el tipo de cotización DENTRO del formulario (app/cotizar/page.js).
// Módulo puro: sin React, sin red. NO define reglas nuevas: usa las que ya existen (computeRequiresServiceSuggestion para «requiere servicio»
// y lo que imprime lib/pdf.js: el tiempo de instalación solo sale en Instalación y Servicios). Aquí solo se calcula QUÉ cambiaría al guardar,
// para avisar antes. El formulario NO borra nada al cambiar de tipo: todo queda en su estado; lo que sí cambia es qué se guarda/imprime.

import { computeRequiresServiceSuggestion } from '@/lib/quoteSnapshot'

export const QUOTE_TYPE_LABELS = { instalacion: 'Instalación', servicio: 'Servicios', venta: 'Venta de productos' }
export const quoteTypeLabel = (value) => QUOTE_TYPE_LABELS[value] || ''

const hasValue = (v) => v !== '' && v != null && !Number.isNaN(v)

// «¿Requiere servicio?» con el tipo dado, igual que el formulario: si la persona lo fijó a mano se respeta; si no, se sugiere según tipo y conceptos.
export function requiresServiceFor(type, { items, requiresServiceOverridden, requiresServiceManual }) {
  return requiresServiceOverridden ? !!requiresServiceManual : computeRequiresServiceSuggestion(type, items)
}

// Efectos de pasar de `from` a `to`.
//  losses: información ya capturada que dejaría de guardarse o imprimirse (hay que explicarla y pedir confirmación).
//  notes:  efectos que no descartan nada (se informan después de aplicar, sin pedir confirmación).
// serviceAddress: { origin, address } con la dirección de servicio ya resuelta por el formulario (origin: selected_client_address | other_client_address | manual).
export function quoteTypeChangeEffects({ from, to, items, requiresServiceOverridden, requiresServiceManual, installTimeValue, installTimeUnit, serviceAddress }) {
  const losses = [], notes = []
  if (!to || from === to) return { losses, notes }
  const state = { items, requiresServiceOverridden, requiresServiceManual }
  const before = requiresServiceFor(from, state)
  const after = requiresServiceFor(to, state)

  // Dirección de servicio: solo es «información específica» si la persona la capturó aparte (manual u otra dirección registrada).
  // La del cliente seleccionada no se pierde: sigue en los datos del cliente.
  const addr = serviceAddress && typeof serviceAddress.address === 'string' ? serviceAddress.address.trim() : ''
  if (before && !after && serviceAddress && serviceAddress.origin !== 'selected_client_address' && addr) {
    losses.push({
      id: 'service_address',
      text: `La dirección de servicio capturada («${addr}») ya no se guardará en la cotización: con «${quoteTypeLabel(to)}» y sin conceptos de servicio no se pide servicio ni se imprime esa dirección.`,
    })
  }
  if (!before && after) {
    notes.push({ id: 'service_required', text: `Con «${quoteTypeLabel(to)}» se pide servicio: indica la dirección donde se realizará.` })
  }

  // Tiempo de instalación: se guarda en todos los tipos, pero el PDF solo lo imprime en Instalación y Servicios (lib/pdf.js).
  const printedBefore = from !== 'venta', printedAfter = to !== 'venta'
  if (hasValue(installTimeValue)) {
    const unit = installTimeUnit === 'dias' ? (installTimeValue == 1 ? 'día' : 'días') : (installTimeValue == 1 ? 'hora' : 'horas')
    if (printedBefore && !printedAfter) {
      losses.push({ id: 'install_time', text: `El tiempo de instalación estimado (${installTimeValue} ${unit}) no aparecerá en el PDF de «${quoteTypeLabel(to)}» y el campo se oculta; el valor se conserva y reaparece si vuelves a un tipo con instalación.` })
    } else if (!printedBefore && printedAfter) {
      notes.push({ id: 'install_time', text: `El tiempo de instalación estimado (${installTimeValue} ${unit}) se imprimirá en el PDF.` })
    }
  }
  return { losses, notes }
}
