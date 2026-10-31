// app/page.js — Inicio (N2, ronda Donnie): página principal. Banner, accesos rápidos, resumen y últimas cotizaciones.
// Resumen y últimas cotizaciones salen de lecturas reales (lib/inicioLoad.js) con los estados reales del sistema; no hay indicadores ni datos de muestra.
// Carga, fallo y «sin cotizaciones» son tres estados distintos y nunca se confunden. Los accesos disponibles usan las rutas actuales.
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { QUICK_ACCESS, moduleById } from '@/lib/donnieNav'
import { loadInicioData, logInicioFailures, isInicioEmpty, INICIO_LOAD_ERROR_MESSAGE } from '@/lib/inicioLoad'
import { resolveQuoteServiceView } from '@/lib/quoteServiceView'
import DonnieIcon from '@/components/DonnieIcon'
import { announceSoon } from '@/components/DonnieToast'

const initials = (name) => {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
  return w.length ? w.map((x) => x[0]).join('').toUpperCase() : '·'
}

function Kpi({ label, value, hint, tone }) {
  return (
    <div className="dn-kpi" data-tone={tone}>
      <div className="dn-kpi-label">{label}</div>
      <div className="dn-kpi-num">{value}</div>
      <div className="dn-kpi-hint">{hint}</div>
    </div>
  )
}

export default function InicioPage() {
  const [state, setState] = useState({ status: 'loading' }) // loading | ready | error
  const [attempt, setAttempt] = useState(0)
  const busy = useRef(false)

  useEffect(() => {
    let active = true
    busy.current = true
    loadInicioData(supabase).then((result) => {
      busy.current = false
      if (!active) return // respuesta de una carga anterior: no escribe la pantalla
      if (!result.ok) { logInicioFailures(result.failures); setState({ status: 'error' }); return }
      setState({ status: 'ready', data: result })
    })
    return () => { active = false }
  }, [attempt])

  const retry = useCallback(() => {
    if (busy.current) return // ya hay una consulta en curso: sin solicitudes superpuestas
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  const negocio = moduleById('mi-negocio')
  const operaciones = moduleById('operaciones')
  const data = state.status === 'ready' ? state.data : null

  return (
    <div className="dn-home">
      <section className="dn-hero" aria-labelledby="dn-h1">
        <div>
          <div className="dn-eyebrow">Bienvenido a Donnie</div>
          <h1 id="dn-h1">Jamás fue tan fácil gestionar tu negocio</h1>
          <p>Cotiza, da seguimiento a tus clientes y agenda tus servicios desde un solo lugar.</p>
        </div>
        <div className="dn-hero-soon" role="group" aria-label="Próximos módulos principales">
          {[negocio, operaciones].map((m) => (
            <button key={m.id} type="button" className="dn-hbtn" aria-disabled="true" aria-label={`${m.label}, próximamente`} onClick={() => announceSoon(m.label)}>
              <DonnieIcon name={m.icon} /><span>{m.label}<small>Próximamente</small></span>
            </button>
          ))}
        </div>
      </section>

      <section className="dn-section" aria-labelledby="dn-hq">
        <div className="dn-section-head"><h2 id="dn-hq">Accesos rápidos</h2></div>
        <div className="dn-quick">
          {QUICK_ACCESS.map((m) => (
            <Link key={m.id} href={m.href} className="dn-tile">
              <span className="dn-tile-ico"><DonnieIcon name={m.icon} /></span>
              <span className="dn-tile-tx"><span className="dn-tag">{m.cat}</span><b>{m.label}</b><small>{m.desc}</small></span>
              <span className="dn-tile-go"><DonnieIcon name="right" /></span>
            </Link>
          ))}
        </div>
      </section>

      <section className="dn-section" aria-labelledby="dn-hr">
        <div className="dn-section-head"><h2 id="dn-hr">Resumen</h2></div>
        {state.status === 'loading' && (
          <div className="dn-kpis" aria-busy="true" aria-label="Cargando resumen">
            {[0, 1, 2, 3].map((i) => <div key={i} className="dn-kpi dn-kpi-skel" aria-hidden="true" />)}
          </div>
        )}
        {state.status === 'error' && (
          <div className="dn-state dn-state-error" role="alert">
            <div><b>No se pudo cargar el resumen</b><span>{INICIO_LOAD_ERROR_MESSAGE}</span></div>
            <button type="button" className="dn-ghost-btn" onClick={retry}>Reintentar</button>
          </div>
        )}
        {data && (
          <div className="dn-kpis">
            <Kpi label="En cotización" value={data.counts.precontractual} hint="aún sin contratar" tone="orange" />
            <Kpi label="Contratadas" value={data.counts.contracted} hint="contratación vigente" tone="blue" />
            <Kpi label="Canceladas" value={data.counts.cancelled} hint="contratación cancelada" tone="gray" />
            <Kpi label="Servicios por agendar" value={data.counts.pendingServices} hint="pendientes de agendar" tone="orange" />
          </div>
        )}
      </section>

      <section className="dn-card dn-section" aria-labelledby="dn-hu">
        <div className="dn-section-head dn-flush"><h2 id="dn-hu">Últimas cotizaciones</h2><Link href="/historial">Ver todas</Link></div>
        <p className="dn-sub">Lo más reciente de Mis cotizaciones.</p>
        {state.status === 'loading' && <div className="dn-list-skel" aria-busy="true" aria-label="Cargando cotizaciones">{[0, 1, 2].map((i) => <div key={i} className="dn-skel-row" aria-hidden="true" />)}</div>}
        {state.status === 'error' && (
          <div className="dn-state dn-state-error" role="alert">
            <div><b>No se pudieron cargar las cotizaciones</b><span>{INICIO_LOAD_ERROR_MESSAGE}</span></div>
            <button type="button" className="dn-ghost-btn" onClick={retry}>Reintentar</button>
          </div>
        )}
        {data && isInicioEmpty(data) && (
          <div className="dn-state dn-state-empty">
            <div><b>Aún no hay cotizaciones</b><span>Cuando crees la primera aparecerá aquí.</span></div>
            <Link href="/cotizar" className="dn-ghost-btn"><DonnieIcon name="plus" />Nueva cotización</Link>
          </div>
        )}
        {data && !isInicioEmpty(data) && (
          <ul className="dn-recent">
            {data.recent.map((q) => {
              const badge = resolveQuoteServiceView(q, []).badges[0]
              return (
                <li key={q.id}>
                  <span className="dn-av" aria-hidden="true">{initials(q.client_name)}</span>
                  <span className="dn-recent-tx">
                    <span className="dn-recent-name" title={q.client_name || ''}>{q.client_name || 'Sin nombre de cliente'}</span>
                    <span className="dn-recent-meta">{q.folio} · {new Date(q.created_at).toLocaleDateString('es-MX')}</span>
                  </span>
                  <span className={`badge ${badge.tone}`}>{badge.text}</span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
