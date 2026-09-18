// app/clientes/page.js
'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

export default function ClientesPage() {
  const [clients, setClients] = useState([])
  const [searchText, setSearchText] = useState('')
  const router = useRouter()

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

  async function deleteClient(c) {
    const ok = window.confirm(
      `¿Seguro que deseas eliminar a ${c.name || 'este cliente'}?\n\nAl eliminarlo se borrará permanentemente y no podrás recuperarlo.`
    )
    if (!ok) return
    const { error } = await supabase.from('clients').delete().eq('id', c.id)
    if (error) { alert('No se pudo eliminar: ' + error.message); return }
    load()
  }

  return (
    <div>
      <h2 className="pagetitle">Clientes</h2>
      <div className="pagesub">Registro maestro de clientes — se llenó solo a partir de tus cotizaciones. Para consultar el detalle o editar los datos de un cliente usa &quot;Ver cliente&quot;.</div>

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
              <thead><tr><th>Nombre</th><th>Teléfono</th><th>Correo</th><th>Dirección</th><th></th></tr></thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id}>
                    <td className="cell-ell" title={c.name || ''}>{c.name || '—'}</td>
                    <td className="cell-ell" title={c.phone || ''}>{c.phone || '—'}</td>
                    <td className="cell-ell" title={c.email || ''}>{c.email || '—'}</td>
                    <td className="cell-ell" title={c.address || ''}>{c.address || '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn ghost small" onClick={() => router.push(`/clientes/${c.id}`)}>Ver cliente</button>
                        <button className="btn teal small" onClick={() => router.push(`/cotizar?client=${c.id}`)}>Nueva cotización</button>
                        <button className="iconbtn" title="Eliminar cliente" onClick={() => deleteClient(c)}>✕</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="helptext" style={{ marginTop: 10 }}>
        Editar los datos de un cliente (desde &quot;Ver cliente&quot;) no cambia las cotizaciones ya generadas — esas conservan una copia propia de los datos
        tal como estaban en ese momento; sí se usa para prellenar cotizaciones y servicios nuevos.
      </div>
    </div>
  )
}
