// app/servicios/page.js
'use client'
import { useEffect, useMemo, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { SERVICE_STATUS_LABEL as STATUS_LABEL, SERVICE_STATUS_BADGE as STATUS_BADGE } from '@/lib/serviceStatus'
import { parseQuoteIdParam, filterKeyOf, loadServicesForList, resolveServicesListState, filterServicesForList } from '@/lib/serviceListFilter'
import { isQuoteCancelled } from '@/lib/serviceGuard'

const NO_SERVICES = [] // referencia estable para memoizar cuando no hay servicios

function ServiciosInner() {
  const [loaded, setLoaded] = useState(null) // { key, services, error } de la última carga terminada
  const [searchText, setSearchText] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const router = useRouter()
  const params = useSearchParams()

  // Fase 6.7C-1.3b — filtro OPCIONAL /servicios?quoteId=<quotes.id>. Sin el
  // parámetro todo funciona como antes. El filtro de la URL es de navegación,
  // no de autorización: RLS sigue decidiendo qué filas se ven.
  const rawQuoteId = params.get('quoteId')
  const filter = useMemo(() => parseQuoteIdParam(rawQuoteId), [rawQuoteId])
  const filterKey = filterKeyOf(filter) // 'all' | uuid | null (uuid inválido: no se consulta)
  const isFiltered = filter.state !== 'none'

  useEffect(() => {
    if (filterKey === null) return
    let cancelled = false
    // Trae el servicio junto con su cotización (folio); con filtro, solo los de esa cotización.
    loadServicesForList(supabase, filterKey).then(({ services, error }) => {
      if (!cancelled) setLoaded({ key: filterKey, services, error })
    })
    return () => { cancelled = true } // una respuesta tardía de otra URL no se pinta
  }, [filterKey])

  const view = useMemo(() => resolveServicesListState(filter, loaded), [filter, loaded])
  const services = view.services || NO_SERVICES
  const quoteFolio = isFiltered && view.kind === 'ready' ? services[0]?.quotes?.folio : null

  const filtered = useMemo(
    () => filterServicesForList(services, { searchText, statusFilter }),
    [services, searchText, statusFilter]
  )

  const backToAll = (
    <button className="btn ghost small" onClick={() => router.push('/servicios')}>Ver todos los servicios</button>
  )

  if (view.kind === 'invalid' || view.kind === 'error') {
    return (
      <div>
        <h2 className="pagetitle">Servicios</h2>
        <div className="pagesub">Servicios de la cotización seleccionada.</div>
        <div className="panel">
          <div className="muted" style={{ padding: 30, textAlign: 'center' }}>
            <div style={{ marginBottom: 12 }}>
              {view.kind === 'invalid' ? 'El identificador de cotización no es válido' : 'No se pudieron cargar los servicios de esta cotización.'}
            </div>
            {backToAll}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <h2 className="pagetitle">Servicios</h2>
      <div className="pagesub">
        {isFiltered
          ? `Servicios de la cotización seleccionada${quoteFolio ? ` (${quoteFolio})` : ''}.`
          : 'Todos los servicios agendados a partir de cotizaciones contratadas.'}
      </div>

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
            {isFiltered ? (
              <button className="btn ghost small" style={{ width: '100%' }} onClick={() => router.push('/servicios')}>Ver todos los servicios</button>
            ) : (
              <button className="btn teal small" style={{ width: '100%' }} onClick={() => router.push('/servicios/nuevo')}>+ Agendar servicio</button>
            )}
          </div>
        </div>
      </div>

      {isFiltered && view.kind === 'loading' ? (
        <div className="panel"><div className="muted" style={{ padding: 30, textAlign: 'center' }}>Cargando…</div></div>
      ) : isFiltered && !services.length ? (
        <div className="panel"><div className="muted" style={{ padding: 30, textAlign: 'center' }}>
          <div style={{ marginBottom: 12 }}>No se encontraron servicios para esta cotización.</div>
          {backToAll}
        </div></div>
      ) : !filtered.length ? (
        <div className="panel"><div className="muted" style={{ padding: 30, textAlign: 'center' }}>
          {services.length ? 'No hay resultados con esos filtros.' : 'Todavía no has agendado ningún servicio.'}
        </div></div>
      ) : (
        <div className="panel" style={{ padding: '6px 12px' }}>
          {filtered.map((s) => {
            // Fase 6.7C-1.3c: contratación cancelada => el servicio es de solo consulta (Ver en vez de Editar).
            const cancelledContract = isQuoteCancelled(s.quotes)
            return (
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
                {cancelledContract && <span className="badge neutral" style={{ marginLeft: 4 }}>Contratación cancelada</span>}
              </div>
              <div className="hist-actions">
                {s.google_event_link && <a className="btn ghost small" href={s.google_event_link} target="_blank" rel="noopener">Ver calendario</a>}
                <button className="btn ghost small" onClick={() => router.push(`/servicios/${s.id}`)}>{cancelledContract ? 'Ver' : 'Editar'}</button>
              </div>
            </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function ServiciosPage() {
  // useSearchParams requiere Suspense para poder prerenderizar la ruta (igual que /servicios/nuevo).
  return <Suspense fallback={<div>Cargando…</div>}><ServiciosInner /></Suspense>
}
