// app/clientes/page.js
'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import {
  kindLabel, hasQuoteHistory, deactivateClient, reactivateClient, deleteClientPhysically,
  getFavoriteClientIds, setClientFavorite,
} from '@/lib/clientDetails'

export default function ClientesPage() {
  const [userId, setUserId] = useState(null)
  const [clients, setClients] = useState([])
  const [favoriteIds, setFavoriteIds] = useState(new Set())
  const [searchText, setSearchText] = useState('')
  const [filterStatus, setFilterStatus] = useState('active') // 'active' | 'inactive' | 'all'
  const [onlyFavorites, setOnlyFavorites] = useState(false)
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  async function load() {
    setLoading(true)
    let q = supabase.from('clients').select('*').order('name')
    if (filterStatus === 'active') q = q.eq('active', true)
    else if (filterStatus === 'inactive') q = q.eq('active', false)
    const { data } = await q
    setClients(data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [filterStatus])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const uid = data.session?.user?.id || null
      setUserId(uid)
      if (uid) getFavoriteClientIds(uid).then(setFavoriteIds)
    })
  }, [])

  const filtered = useMemo(() => {
    const t = searchText.trim().toLowerCase()
    let list = clients
    if (t) list = list.filter((c) => `${c.name} ${c.phone} ${c.email}`.toLowerCase().includes(t))
    if (onlyFavorites) list = list.filter((c) => favoriteIds.has(c.id))
    return list
  }, [clients, searchText, onlyFavorites, favoriteIds])

  async function toggleFavorite(c) {
    if (!userId) return
    const isFav = favoriteIds.has(c.id)
    setFavoriteIds((prev) => {
      const next = new Set(prev)
      if (isFav) next.delete(c.id)
      else next.add(c.id)
      return next
    })
    await setClientFavorite(userId, c.id, !isFav)
  }

  async function handleRemove(c) {
    const withHistory = await hasQuoteHistory(c.id)
    if (withHistory) {
      const ok = window.confirm(
        `${c.name || 'Este cliente'} tiene cotizaciones registradas, así que no se puede eliminar.\n\n¿Deseas desactivarlo en su lugar? Podrás reactivarlo cuando quieras y su historial no se ve afectado.`
      )
      if (!ok) return
      await deactivateClient(c.id)
    } else {
      const ok = window.confirm(
        `¿Seguro que deseas eliminar a ${c.name || 'este cliente'}?\n\nNo tiene cotizaciones registradas, así que se borrará permanentemente y no podrás recuperarlo.`
      )
      if (!ok) return
      await deleteClientPhysically(c.id)
    }
    load()
  }

  async function handleReactivate(c) {
    await reactivateClient(c.id)
    load()
  }

  return (
    <div>
      <h2 className="pagetitle">Clientes</h2>
      <div className="pagesub">Registro maestro de clientes — se llenó solo a partir de tus cotizaciones. Para consultar el detalle o editar los datos de un cliente usa &quot;Ver cliente&quot;.</div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="fieldrow" style={{ marginBottom: 0 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Buscar por nombre, teléfono o correo</label>
            <input value={searchText} onChange={(e) => setSearchText(e.target.value)} />
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
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, marginBottom: 0, cursor: 'pointer' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={onlyFavorites} onChange={(e) => setOnlyFavorites(e.target.checked)} /> Solo favoritos
        </label>
      </div>

      <div className="panel">
        {loading ? (
          <div className="muted" style={{ padding: 20, textAlign: 'center' }}>Cargando…</div>
        ) : !filtered.length ? (
          <div className="muted" style={{ padding: 20, textAlign: 'center' }}>No hay clientes que coincidan.</div>
        ) : (
          <div className="table-scroll">
            <table className="datatable">
              <thead><tr><th></th><th>Nombre</th><th>Tipo</th><th>Teléfono</th><th>Correo</th><th>Dirección</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <button
                        type="button" className={`star-btn ${favoriteIds.has(c.id) ? 'is-fav' : ''}`}
                        title={favoriteIds.has(c.id) ? 'Quitar de favoritos' : 'Marcar como favorito'}
                        onClick={() => toggleFavorite(c)} disabled={!userId}
                      >★</button>
                    </td>
                    <td className="cell-ell" title={c.name || ''}>{c.name || '—'}</td>
                    <td><span className="badge neutral">{kindLabel(c.kind)}</span></td>
                    <td className="cell-ell" title={c.phone || ''}>{c.phone || '—'}</td>
                    <td className="cell-ell" title={c.email || ''}>{c.email || '—'}</td>
                    <td className="cell-ell" title={c.address || ''}>{c.address || '—'}</td>
                    <td><span className={`badge ${c.active ? 'rec' : 'can'}`}>{c.active ? 'ACTIVO' : 'INACTIVO'}</span></td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <button className="btn ghost small" onClick={() => router.push(`/clientes/${c.id}`)}>Ver cliente</button>
                        <button className="btn teal small" onClick={() => router.push(`/cotizar?client=${c.id}`)}>Nueva cotización</button>
                        {c.active ? (
                          <button className="iconbtn" title="Eliminar o desactivar cliente" onClick={() => handleRemove(c)}>✕</button>
                        ) : (
                          <button className="btn ghost small" onClick={() => handleReactivate(c)}>Reactivar</button>
                        )}
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
        tal como estaban en ese momento; sí se usa para prellenar cotizaciones y servicios nuevos. Un cliente inactivo conserva intacto todo su historial y puede reactivarse en cualquier momento.
      </div>
    </div>
  )
}
