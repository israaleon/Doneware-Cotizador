// app/clientes/page.js
'use client'
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

export default function ClientesPage() {
  const [clients, setClients] = useState([])
  const [searchText, setSearchText] = useState('')

  async function load() {
    const { data } = await supabase.from('clients').select('*').order('name')
    setClients(data || [])
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    const t = searchText.trim().toLowerCase()
    if (!t) return clients
    return clients.filter((c) => `${c.name} ${c.phone} ${c.email}`.toLowerCase().includes(t))
  }, [clients, searchText])

  function updateField(id, field, value) {
    setClients((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)))
  }
  async function saveRow(id) {
    const row = clients.find((c) => c.id === id)
    await supabase.from('clients').update({
      name: row.name, phone: row.phone, email: row.email, address: row.address, updated_at: new Date().toISOString(),
    }).eq('id', id)
  }

  return (
    <div>
      <h2 className="pagetitle">Clientes</h2>
      <div className="pagesub">Registro maestro de clientes — se llenó solo a partir de tus cotizaciones. Aquí puedes corregir datos o unificar duplicados.</div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Buscar por nombre, teléfono o correo</label>
          <input value={searchText} onChange={(e) => setSearchText(e.target.value)} />
        </div>
      </div>

      <div className="panel">
        {!filtered.length ? (
          <div className="muted" style={{ padding: 20, textAlign: 'center' }}>No hay clientes que coincidan.</div>
        ) : (
          <div className="table-scroll">
            <table className="datatable">
              <thead><tr><th>Nombre</th><th>Teléfono</th><th>Correo</th><th>Dirección</th></tr></thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id}>
                    <td><input value={c.name || ''} onChange={(e) => updateField(c.id, 'name', e.target.value)} onBlur={() => saveRow(c.id)} /></td>
                    <td><input value={c.phone || ''} onChange={(e) => updateField(c.id, 'phone', e.target.value)} onBlur={() => saveRow(c.id)} /></td>
                    <td><input value={c.email || ''} onChange={(e) => updateField(c.id, 'email', e.target.value)} onBlur={() => saveRow(c.id)} /></td>
                    <td><input value={c.address || ''} onChange={(e) => updateField(c.id, 'address', e.target.value)} onBlur={() => saveRow(c.id)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="helptext" style={{ marginTop: 10 }}>
        Editar aquí no cambia las cotizaciones ya generadas (esas conservan una copia propia de los datos del cliente tal como
        estaban en ese momento) — sí se usa para prellenar cotizaciones y servicios nuevos.
      </div>
    </div>
  )
}
