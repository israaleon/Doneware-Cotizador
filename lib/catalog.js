// lib/catalog.js
// Búsqueda, filtros, favoritos y "más usados" del catálogo — separado de la UI
// para que Fase 5 (selector dentro de Nueva Cotización) reutilice exactamente
// esta misma lógica sin duplicarla.
import { supabase } from './supabaseClient'

export const norm = (s) => String(s || '').toLowerCase().trim()

// ---------- Filtros estructurados (sí van al servidor) ----------
// status: 'active' | 'inactive' | 'all' (default 'active')
export async function fetchCatalogItems({ type, category, tags, status = 'active' } = {}) {
  let q = supabase.from('catalog_items').select('*')
  if (status === 'active') q = q.eq('active', true)
  else if (status === 'inactive') q = q.eq('active', false)
  // status === 'all' -> sin filtro de estado
  if (type) q = q.eq('type', type)
  if (category) q = q.eq('category', category)
  if (tags && tags.length) q = q.overlaps('tags', tags) // coincidencia exacta de al menos un tag
  const { data, error } = await q.order('name')
  return { data: data || [], error }
}

// ---------- Texto libre (NO es un filtro de Supabase — se evalúa aquí, sobre
// el resultado que ya trajeron los filtros estructurados de arriba). Revisa
// nombre, SKU, categoría, tags y TODO specs (vía JSON.stringify, sin depender
// de conocer sus claves) — así "Dahua" encuentra un item aunque solo exista
// dentro de specs.marca. `description` se suma aquí en cuanto exista la
// columna; por ahora el campo simplemente no está presente y se ignora. ----------
export function searchInItems(items, text) {
  const t = norm(text)
  if (!t) return items
  return items.filter((it) => {
    const haystack = [
      it.name,
      it.sku,
      it.category,
      it.description, // hoy siempre undefined; queda listo para cuando exista
      ...(it.tags || []),
      JSON.stringify(it.specs || {}),
    ].filter(Boolean).join(' ')
    return norm(haystack).includes(t)
  })
}

export function distinctCategories(items) {
  return [...new Set(items.map((it) => it.category).filter(Boolean))].sort()
}

export function distinctTags(items) {
  return [...new Set(items.flatMap((it) => it.tags || []))].sort()
}

// ---------- Favoritos (por usuario) ----------
export async function getFavoriteIds(userId) {
  if (!userId) return new Set()
  const { data } = await supabase.from('catalog_favorites').select('catalog_item_id').eq('user_id', userId)
  return new Set((data || []).map((r) => r.catalog_item_id))
}

export async function setFavorite(userId, catalogItemId, isFavorite) {
  if (isFavorite) {
    return supabase.from('catalog_favorites').insert({ user_id: userId, catalog_item_id: catalogItemId })
  }
  return supabase.from('catalog_favorites').delete().eq('user_id', userId).eq('catalog_item_id', catalogItemId)
}

// ---------- Más usados / recientes ----------
// Se calcula siempre desde `quotes` — nunca se guarda un contador en catalog_items.
// Solo se cuentan cotizaciones (no sus recibos, que son una copia del mismo
// concepto y duplicarían el conteo).
//
// Prioriza `catalog_item_id` en cada concepto de la cotización cuando exista
// (lo agregará Fase 5 al snapshot); hoy ninguna cotización lo tiene, así que
// el fallback real es por nombre normalizado. Esto es aproximado para datos
// legacy: si un producto se renombra en el catálogo, deja de emparejar con
// cotizaciones anteriores a ese cambio.
export async function fetchUsageCounts() {
  const { data } = await supabase.from('quotes').select('items').eq('status', 'cotizacion')
  const byId = new Map()
  const byName = new Map()
  ;(data || []).forEach((q) => {
    ;(q.items || []).forEach((it) => {
      const qty = Number(it.qty) || 1
      if (it.catalog_item_id) byId.set(it.catalog_item_id, (byId.get(it.catalog_item_id) || 0) + qty)
      else if (it.name) {
        const key = norm(it.name)
        byName.set(key, (byName.get(key) || 0) + qty)
      }
    })
  })
  return { byId, byName }
}

export function usageCountFor(item, { byId, byName }) {
  return byId.get(item.id) || byName.get(norm(item.name)) || 0
}

export function sortByUsage(items, usage) {
  return [...items].sort((a, b) => usageCountFor(b, usage) - usageCountFor(a, usage))
}
