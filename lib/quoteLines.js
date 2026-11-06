// lib/quoteLines.js — N3-C (ronda Donnie): lógica pura de los conceptos del formulario de cotización.
// Sin React ni red. No cambia el modelo guardado: las filas siguen siendo las de catalogItemToLine/withRecalculatedSubtotal (lib/quoteSnapshot.js).

import { catalogItemToLine, withRecalculatedSubtotal } from '@/lib/quoteSnapshot'

// Resumen de textos largos (título y descripción): hasta SUMMARY_MAX caracteres, contando el «…». Solo se resume si el texto SUPERA el límite.
// Es solo de presentación: el texto guardado (conceptos, snapshots, PDF) nunca se recorta.
export const SUMMARY_MAX = 68
export function summarizeText(text, max = SUMMARY_MAX) {
  const chars = Array.from(String(text == null ? '' : text))
  if (chars.length <= max) return { text: chars.join(''), truncated: false }
  return { text: chars.slice(0, max - 1).join('').trimEnd() + '…', truncated: true }
}

// Un producto se identifica SOLO por catalog_item_id (nunca por nombre). Los conceptos manuales (catalog_item_id nulo) no se agrupan jamás.
export function catalogLineIndexes(items, catalogItemId) {
  if (catalogItemId == null) return []
  const out = []
  ;(items || []).forEach((it, i) => { if (it && it.catalog_item_id != null && it.catalog_item_id === catalogItemId) out.push(i) })
  return out
}

// Productos que ya aparecen en VARIAS filas (cotizaciones históricas): se identifican, no se fusionan. [{ id, name, count, indexes }]
export function duplicateCatalogProducts(items) {
  const byId = new Map()
  ;(items || []).forEach((it, i) => {
    if (!it || it.catalog_item_id == null) return
    const e = byId.get(it.catalog_item_id) || { id: it.catalog_item_id, name: it.name || '', count: 0, indexes: [] }
    e.count += 1; e.indexes.push(i); byId.set(it.catalog_item_id, e)
  })
  return [...byId.values()].filter((e) => e.count > 1)
}

// «+ Añadir» de atajos y buscador.
//  - sin fila del producto  → fila nueva (precio del catálogo, cantidad 1)                      { kind: 'added', index }
//  - exactamente una fila   → su cantidad sube 1 y se recalcula el importe; precio y textos editados no se tocan   { kind: 'incremented', index, qty }
//  - varias filas (histórico) → no se modifica nada: el criterio de fusión se decide aparte       { kind: 'ambiguous', count }
export function addCatalogProduct(items, catalogItem) {
  const list = items || []
  const idx = catalogLineIndexes(list, catalogItem.id)
  if (idx.length === 0) {
    const next = [...list, catalogItemToLine(catalogItem, 1, catalogItem.price)]
    return { items: next, outcome: { kind: 'added', index: next.length - 1 } }
  }
  if (idx.length === 1) {
    const i = idx[0]
    const qty = (Number(list[i].qty) || 0) + 1
    const next = list.slice()
    next[i] = withRecalculatedSubtotal({ ...list[i], qty })
    return { items: next, outcome: { kind: 'incremented', index: i, qty } }
  }
  return { items: list, outcome: { kind: 'ambiguous', count: idx.length } }
}
