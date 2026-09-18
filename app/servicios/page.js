// app/servicios/page.js
'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { SERVICE_STATUS_LABEL as STATUS_LABEL, SERVICE_STATUS_BADGE as STATUS_BADGE } from '@/lib/serviceStatus'

export default function ServiciosPage() {
  const [services, setServices] = useState([])
  const [searchText, setSearchText] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const router = useRouter()

  async function load() {
    // Trae el servicio junto con su cotización (folio) — Supabase permite
    // "embeber" la fila relacionada por la foreign key quote_id.
    const { data } = await supabase
      .from('services')
      .select('*, quotes(folio, client_name, client_phone)')
      .order('start_at', { ascending: true, nullsFirst: false })
    setServices(data || [])
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    const text = searchText.trim().toLowerCase()
    return services.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false
      if (text) {
        const haystack = `${s.quotes?.client_name || ''} ${s.service_type || ''} ${s.quotes?.folio || ''}`.toLowerCase()
        if (!haystack.includes(text)) return false
      }
      return true
    })
  }, [services, searchText, statusFilter])

  return (
    <div>
      <h2 className="pagetitle">Servicios</h2>
      <div className="pagesub">Todos los servicios agendados a partir de cotizaciones contratadas.</div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="hist-search-grid">
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Buscar por cliente, servicio o folio</label>
            <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Ej. Juan Pérez o Instalación" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Estado</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">Todos</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0, display: 'flex', alignItems: 'flex-end' }}>
            <button className="btn teal small" style={{ width: '100%' }} onClick={() => router.push('/servicios/nuevo')}>+ Agendar servicio</button>
          </div>
        </div>
      </div>

      {!filtered.length ? (
        <div className="panel"><div className="muted" style={{ padding: 30, textAlign: 'center' }}>
          {services.length ? 'No hay resultados con esos filtros.' : 'Todavía no has agendado ningún servicio.'}
        </div></div>
      ) : (
        <div className="panel" style={{ padding: '6px 12px' }}>
          {filtered.map((s) => (
            <div className="hist-row hist-row-svc" key={s.id}>
              <div>
                <div className="ell" title={s.quotes?.client_name}>{s.quotes?.client_name || 'Cliente'}</div>
                <div className="muted ell">{s.quotes?.client_phone}</div>
              </div>
              <div>
                <div className="ell" title={s.service_type}>{s.service_type || 'Servicio'}</div>
                <div className="muted ell">Cotización {s.quotes?.folio}</div>
              </div>
              <div className="ell" style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>
                {s.start_at ? new Date(s.start_at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) : 'Sin fecha'}
              </div>
              <div>
                <span className={`badge ${STATUS_BADGE[s.status]}`}>{STATUS_LABEL[s.status]}</span>
                {s.sync_status === 'error' && <span className="badge cot" style={{ marginLeft: 4, background: '#FBEAE6', color: 'var(--red)' }}>SIN SINCRONIZAR</span>}
              </div>
              <div className="hist-actions">
                {s.google_event_link && <a className="btn ghost small" href={s.google_event_link} target="_blank" rel="noopener">Ver calendario</a>}
                <button className="btn ghost small" onClick={() => router.push(`/servicios/${s.id}`)}>Editar</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
