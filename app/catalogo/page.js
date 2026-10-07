// app/catalogo/page.js
'use client'
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import {
  fetchCatalogItems, searchInItems, distinctCategories, distinctTags,
  getFavoriteIds, setFavorite, fetchUsageCounts, usageCountFor, sortByUsage,
} from '@/lib/catalog'

const UNITS = ['pieza', 'servicio', 'mes', 'hora']

function specsToRows(specs) {
  const entries = Object.entries(specs || {})
  return entries.length ? entries.map(([k, v]) => [k, String(v)]) : [['', '']]
}
function rowsToSpecs(rows) {
  const out = {}
  rows.forEach(([k, v]) => { if (k && k.trim()) out[k.trim()] = v })
  return out
}

export default function CatalogoPage() {
  const [userId, setUserId] = useState(null)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [favoriteIds, setFavoriteIds] = useState(new Set())
  const [usage, setUsage] = useState({ byId: new Map(), byName: new Map() })

  const [searchText, setSearchText] = useState('')
  const [debouncedText, setDebouncedText] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [filterTags, setFilterTags] = useState([])
  const [filterStatus, setFilterStatus] = useState('active')
  const [onlyFavorites, setOnlyFavorites] = useState(false)
  const [sortMostUsed, setSortMostUsed] = useState(false)

  const [expanded, setExpanded] = useState({})
  const [specsDraft, setSpecsDraft] = useState({}) // { [itemId]: [[key,value],...] }
  const [tagsDraft, setTagsDraft] = useState({}) // { [itemId]: 'tag1, tag2' }

  const [newItem, setNewItem] = useState({ name: '', type: '', unit: 'pieza', price: '', sku: '', category: '' })
  const [savingNew, setSavingNew] = useState(false)

  // Debounce: el texto libre nunca se manda a Supabase, pero tampoco hace
  // falta re-filtrar en cada tecla — se espera una pausa corta.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedText(searchText), 300)
    return () => clearTimeout(t)
  }, [searchText])

  async function load() {
    setLoading(true)
    const { data } = await fetchCatalogItems({
      type: filterType || undefined,
      category: filterCategory || undefined,
      tags: filterTags.length ? filterTags : undefined,
      status: filterStatus,
    })
    setItems(data)
    setLoading(false)
  }
  useEffect(() => { load() }, [filterType, filterCategory, filterTags, filterStatus])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const uid = data.session?.user?.id || null
      setUserId(uid)
      if (uid) getFavoriteIds(uid).then(setFavoriteIds)
    })
    fetchUsageCounts().then(setUsage)
  }, [])

  const displayItems = useMemo(() => {
    let list = searchInItems(items, debouncedText)
    if (onlyFavorites) list = list.filter((it) => favoriteIds.has(it.id))
    if (sortMostUsed) list = sortByUsage(list, usage)
    return list
  }, [items, debouncedText, onlyFavorites, favoriteIds, sortMostUsed, usage])

  const categories = useMemo(() => distinctCategories(items), [items])
  const allTags = useMemo(() => distinctTags(items), [items])

  function toggleTagFilter(tag) {
    setFilterTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])
  }

  async function toggleFavorite(item) {
    if (!userId) return
    const isFav = favoriteIds.has(item.id)
    setFavoriteIds((prev) => {
      const next = new Set(prev)
      if (isFav) next.delete(item.id)
      else next.add(item.id)
      return next
    })
    await setFavorite(userId, item.id, !isFav)
  }

  function updateField(id, field, value) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, [field]: value } : it)))
  }
  async function saveRow(id) {
    const row = items.find((it) => it.id === id)
    await supabase.from('catalog_items').update({
      name: row.name, unit: row.unit, price: row.price,
      type: row.type || null, sku: row.sku || null, category: row.category || null,
    }).eq('id', id)
  }

  function toggleExpand(item) {
    setExpanded((prev) => ({ ...prev, [item.id]: !prev[item.id] }))
    if (!specsDraft[item.id]) setSpecsDraft((prev) => ({ ...prev, [item.id]: specsToRows(item.specs) }))
    if (tagsDraft[item.id] === undefined) setTagsDraft((prev) => ({ ...prev, [item.id]: (item.tags || []).join(', ') }))
  }

  async function saveTags(item) {
    const tags = (tagsDraft[item.id] || '').split(',').map((t) => t.trim()).filter(Boolean)
    updateField(item.id, 'tags', tags)
    await supabase.from('catalog_items').update({ tags }).eq('id', item.id)
  }

  function updateSpecRow(itemId, idx, col, value) {
    setSpecsDraft((prev) => {
      const rows = prev[itemId].map((r) => [...r])
      rows[idx][col] = value
      return { ...prev, [itemId]: rows }
    })
  }
  function addSpecRow(itemId) {
    setSpecsDraft((prev) => ({ ...prev, [itemId]: [...prev[itemId], ['', '']] }))
  }
  function removeSpecRow(itemId, idx) {
    setSpecsDraft((prev) => {
      const rows = prev[itemId].filter((_, i) => i !== idx)
      return { ...prev, [itemId]: rows.length ? rows : [['', '']] }
    })
  }
  async function saveSpecs(item) {
    const specs = rowsToSpecs(specsDraft[item.id] || [])
    updateField(item.id, 'specs', specs)
    await supabase.from('catalog_items').update({ specs }).eq('id', item.id)
  }

  async function toggleActive(item) {
    const active = !item.active
    // Si el nuevo estado ya no corresponde al filtro de Estado actual, se retira
    // de la lista local de inmediato — si no, se quedaría visible hasta recargar,
    // porque el filtro de estado se resuelve en el servidor al momento de traer
    // los datos, no en cada cambio local.
    const stillMatchesFilter = filterStatus === 'all' || (filterStatus === 'active') === active
    if (stillMatchesFilter) updateField(item.id, 'active', active)
    else setItems((prev) => prev.filter((it) => it.id !== item.id))
    await supabase.from('catalog_items').update({ active }).eq('id', item.id)
  }

  async function addItem() {
    if (!newItem.name.trim()) { alert('Escribe un nombre para el producto o servicio.'); return }
    if (!newItem.type) { alert('Elige si es Producto o Servicio.'); return }
    setSavingNew(true)
    await supabase.from('catalog_items').insert({
      name: newItem.name, unit: newItem.unit, price: parseFloat(newItem.price) || 0,
      type: newItem.type, sku: newItem.sku || null, category: newItem.category || null,
    })
    setNewItem({ name: '', type: '', unit: 'pieza', price: '', sku: '', category: '' })
    setSavingNew(false)
    load()
  }

  return (
    <div>
      <h2 className="pagetitle">Catálogo y precios</h2>
      <div className="pagesub">Los cambios se reflejan de inmediato en las nuevas cotizaciones. Los elementos inactivos dejan de aparecer ahí, pero se conservan para no romper cotizaciones ya generadas.</div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="hist-search-grid">
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Buscar (nombre, SKU, categoría, tags, ficha técnica)</label>
            <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Ej. Dahua, cableado, 4mp..." />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Tipo</label>
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="">Todos</option>
              <option value="producto">Producto</option>
              <option value="servicio">Servicio</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Estado</label>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="active">Activos</option>
              <option value="inactive">Inactivos</option>
              <option value="all">Todos</option>
            </select>
          </div>
        </div>
        <div className="fieldrow" style={{ marginTop: 12, marginBottom: 0 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Categoría</label>
            <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
              <option value="">Todas</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0, display: 'flex', alignItems: 'flex-end', gap: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 0, cursor: 'pointer' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={onlyFavorites} onChange={(e) => setOnlyFavorites(e.target.checked)} /> Solo favoritos
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 0, cursor: 'pointer' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={sortMostUsed} onChange={(e) => setSortMostUsed(e.target.checked)} /> Más usados primero
            </label>
          </div>
        </div>
        {allTags.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <label style={{ display: 'block', fontSize: 11.5, color: 'var(--steel)', marginBottom: 6, fontWeight: 600 }}>Tags</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {allTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={`badge ${filterTags.includes(tag) ? 'rec' : 'cot'}`}
                  style={{ cursor: 'pointer', border: 'none' }}
                  onClick={() => toggleTagFilter(tag)}
                >{tag}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="panel">
        {loading ? (
          <div className="muted" style={{ padding: 20, textAlign: 'center' }}>Cargando…</div>
        ) : !displayItems.length ? (
          <div className="muted" style={{ padding: 20, textAlign: 'center' }}>No hay productos o servicios que coincidan.</div>
        ) : (
          displayItems.map((it) => (
            <div key={it.id} className="cat-item">
              <div className="cat-row">
                <button
                  type="button" className={`star-btn ${favoriteIds.has(it.id) ? 'is-fav' : ''}`}
                  title={favoriteIds.has(it.id) ? 'Quitar de favoritos' : 'Marcar como favorito'}
                  onClick={() => toggleFavorite(it)} disabled={!userId}
                >★</button>
                <div className="field" style={{ marginBottom: 0 }}>
                  <input value={it.name} onChange={(e) => updateField(it.id, 'name', e.target.value)} onBlur={() => saveRow(it.id)} placeholder="Nombre" />
                </div>
                <select value={it.type || ''} onChange={(e) => { updateField(it.id, 'type', e.target.value); }} onBlur={() => saveRow(it.id)}>
                  <option value="">Sin clasificar</option>
                  <option value="producto">Producto</option>
                  <option value="servicio">Servicio</option>
                </select>
                <input type="number" min="0" step="0.01" value={it.price} onChange={(e) => updateField(it.id, 'price', e.target.value)} onBlur={() => saveRow(it.id)} />
                <button type="button" className="hist-toggle" aria-expanded={!!expanded[it.id]} title="Más datos: SKU, categoría, unidad, estado, tags y ficha técnica" onClick={() => toggleExpand(it)}>
                  {expanded[it.id] ? '▲' : '▼'}
                </button>
              </div>

              {expanded[it.id] && (
                <div className="cat-detail">
                  {usageCountFor(it, usage) > 0 && (
                    <div className="helptext" style={{ marginTop: 0 }}>Usado {usageCountFor(it, usage)} {usageCountFor(it, usage) === 1 ? 'vez' : 'veces'} en cotizaciones.</div>
                  )}
                  <div className="cat-detail-grid">
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label>SKU</label>
                      <input value={it.sku || ''} onChange={(e) => updateField(it.id, 'sku', e.target.value)} onBlur={() => saveRow(it.id)} />
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label>Categoría</label>
                      <input value={it.category || ''} onChange={(e) => updateField(it.id, 'category', e.target.value)} onBlur={() => saveRow(it.id)} list="cat-categories" />
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label>Unidad</label>
                      <select value={it.unit} onChange={(e) => { updateField(it.id, 'unit', e.target.value); saveRow(it.id) }}>
                        {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                  </div>
                  <label className="cat-active-toggle" style={{ marginBottom: 14 }}>
                    <input type="checkbox" checked={it.active} onChange={() => toggleActive(it)} />
                    <span>{it.active ? 'Activo (visible en Nueva cotización)' : 'Inactivo (oculto en Nueva cotización)'}</span>
                  </label>
                  <div className="field">
                    <label>Tags (separados por coma)</label>
                    <input
                      value={tagsDraft[it.id] ?? ''}
                      onChange={(e) => setTagsDraft((prev) => ({ ...prev, [it.id]: e.target.value }))}
                      onBlur={() => saveTags(it)}
                      placeholder="Ej. exterior, vision nocturna, 4mp"
                    />
                  </div>
                  <div className="field">
                    <label>Ficha técnica (clave / valor libre)</label>
                    {(specsDraft[it.id] || specsToRows(it.specs)).map(([k, v], idx) => (
                      <div className="cat-specs-row" key={idx}>
                        <input value={k} placeholder="Clave (ej. marca)" onChange={(e) => updateSpecRow(it.id, idx, 0, e.target.value)} onBlur={() => saveSpecs(it)} />
                        <input value={v} placeholder="Valor (ej. Dahua)" onChange={(e) => updateSpecRow(it.id, idx, 1, e.target.value)} onBlur={() => saveSpecs(it)} />
                        <button type="button" className="iconbtn" onClick={() => { removeSpecRow(it.id, idx); }}>✕</button>
                      </div>
                    ))}
                    <button type="button" className="btn ghost small" onClick={() => addSpecRow(it.id)}>+ Agregar campo</button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}

        <datalist id="cat-categories">
          {categories.map((c) => <option key={c} value={c} />)}
        </datalist>

        <div className="cat-add-grid" style={{ gridTemplateColumns: '1.6fr .8fr 1fr 1fr .8fr auto' }}>
          <input placeholder="Nombre del nuevo producto o servicio" value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} />
          <select value={newItem.type} onChange={(e) => setNewItem({ ...newItem, type: e.target.value })}>
            <option value="">Tipo…</option>
            <option value="producto">Producto</option>
            <option value="servicio">Servicio</option>
          </select>
          <input placeholder="SKU (opcional)" value={newItem.sku} onChange={(e) => setNewItem({ ...newItem, sku: e.target.value })} />
          <input placeholder="Categoría (opcional)" value={newItem.category} onChange={(e) => setNewItem({ ...newItem, category: e.target.value })} list="cat-categories" />
          <input type="number" min="0" step="0.01" placeholder="Precio" value={newItem.price} onChange={(e) => setNewItem({ ...newItem, price: e.target.value })} />
          <button className="btn teal small" onClick={addItem} disabled={savingNew}>{savingNew ? 'Agregando…' : '+ Agregar'}</button>
        </div>
      </div>
      <div className="helptext" style={{ marginTop: 10 }}>
        Los campos se guardan al salir de cada casilla. &quot;Inactivo&quot; retira el producto/servicio del selector de Nueva Cotización sin borrarlo — así no se pierden las cotizaciones que ya lo usaron.
      </div>
    </div>
  )
}
