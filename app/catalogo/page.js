// app/catalogo/page.js
'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

export default function CatalogoPage() {
  const [items, setItems] = useState([])
  const [newItem, setNewItem] = useState({ name: '', unit: 'pieza', price: '' })

  async function load() {
    const { data } = await supabase.from('catalog_items').select('*').order('name')
    setItems(data || [])
  }
  useEffect(() => { load() }, [])

  async function updateField(id, field, value) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, [field]: value } : it)))
  }
  async function saveRow(id) {
    const row = items.find((it) => it.id === id)
    await supabase.from('catalog_items').update({ name: row.name, unit: row.unit, price: row.price }).eq('id', id)
  }
  async function removeRow(id) {
    await supabase.from('catalog_items').delete().eq('id', id)
    load()
  }
  async function addItem() {
    if (!newItem.name.trim()) { alert('Escribe un nombre para el producto o servicio.'); return }
    await supabase.from('catalog_items').insert({ name: newItem.name, unit: newItem.unit, price: parseFloat(newItem.price) || 0 })
    setNewItem({ name: '', unit: 'pieza', price: '' })
    load()
  }

  return (
    <div>
      <h2 className="pagetitle">Catálogo y precios</h2>
      <div className="pagesub">Los cambios se reflejan de inmediato en las nuevas cotizaciones.</div>
      <div className="panel">
        <div className="table-scroll">
          <table className="datatable">
            <thead><tr><th>Producto / servicio</th><th>Unidad</th><th>Precio</th><th></th></tr></thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td><input value={it.name} onChange={(e) => updateField(it.id, 'name', e.target.value)} onBlur={() => saveRow(it.id)} /></td>
                  <td>
                    <select value={it.unit} onChange={(e) => { updateField(it.id, 'unit', e.target.value); }} onBlur={() => saveRow(it.id)}>
                      <option value="pieza">Pieza</option>
                      <option value="servicio">Servicio</option>
                      <option value="mes">Mensual</option>
                      <option value="hora">Hora</option>
                    </select>
                  </td>
                  <td><input type="number" min="0" step="0.01" value={it.price} onChange={(e) => updateField(it.id, 'price', e.target.value)} onBlur={() => saveRow(it.id)} /></td>
                  <td style={{ textAlign: 'right' }}><button className="iconbtn" onClick={() => removeRow(it.id)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="cat-add-grid">
          <input placeholder="Nombre del nuevo producto o servicio" value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} />
          <select value={newItem.unit} onChange={(e) => setNewItem({ ...newItem, unit: e.target.value })}>
            <option value="pieza">Pieza</option>
            <option value="servicio">Servicio</option>
            <option value="mes">Mensual</option>
            <option value="hora">Hora</option>
          </select>
          <input type="number" min="0" step="0.01" placeholder="Precio" value={newItem.price} onChange={(e) => setNewItem({ ...newItem, price: e.target.value })} />
          <button className="btn teal small" onClick={addItem}>+ Agregar</button>
        </div>
      </div>
      <div className="helptext" style={{ marginTop: 10 }}>Los campos se guardan al salir de cada casilla (blur). Si prefieres un botón explícito de "Guardar" por fila, es un cambio sencillo de agregar.</div>
    </div>
  )
}
