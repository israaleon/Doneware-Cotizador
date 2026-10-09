// app/servicios/[id]/page.js
'use client'
import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { SERVICE_STATUS_OPTIONS as STATUS_OPTIONS, durationToMinutes, minutesToDuration } from '@/lib/serviceStatus'
import { CANCELLED_NOTICE, UNVERIFIED_NOTICE, resolveServiceAccess, loadServiceContext, mergeServiceContext, verifyQuoteWritable } from '@/lib/serviceGuard'
import { describeServiceApiResult } from '@/lib/serviceApiMessages'

function toDatetimeLocal(d) {
  if (!d) return ''
  const dt = new Date(d)
  const pad = (n) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

function buildForm(svc) {
  const duration = svc.duration_value != null
    ? { value: svc.duration_value, unit: svc.duration_unit || 'horas' }
    : minutesToDuration(svc.duration_minutes)
  return {
    serviceType: svc.service_type || '',
    startAt: toDatetimeLocal(svc.start_at),
    durationValue: duration.value,
    durationUnit: duration.unit,
    address: svc.address || '',
    notes: svc.notes || '',
    status: svc.status,
  }
}

export default function EditarServicioPage() {
  const { id } = useParams()
  const router = useRouter()
  // Fase 6.7C-1.3c / Etapa 1 — contexto { id, service, quote, serviceError, quoteError } de la última respuesta VIGENTE.
  // Solo cuenta si pertenece al servicio actual (id) y la pantalla solo permite escribir cuando la cotización
  // se consultó con éxito y NO está cancelada (lib/serviceGuard.js). Cargando o con error => solo lectura.
  const [ctx, setCtx] = useState(null)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')   // la operación se guardó pero hay algo que revisar (Calendar)
  const reqRef = useRef(0)

  const current = ctx && ctx.id === id ? ctx : null
  const access = resolveServiceAccess(current)
  const service = current && current.service
  const quote = current && current.quote

  async function load() {
    const req = ++reqRef.current
    const res = await loadServiceContext(supabase, id)
    if (req !== reqRef.current) return            // respuesta rezagada (otra carga más nueva o cambio de servicio): se descarta
    setCtx((prev) => mergeServiceContext(prev && prev.id === id ? prev : null, { id, ...res }))
    if (res.service) setForm(buildForm(res.service))
  }
  const invalidate = () => { reqRef.current += 1 }      // descarta cualquier carga en curso
  useEffect(() => { load(); return invalidate }, [id])

  // La cancelación es irreversible: una vez vista, los controles no se vuelven a habilitar.
  function markCancelled() {
    setCtx((prev) => (prev && prev.id === id ? { ...prev, quote: { ...(prev.quote || {}), lifecycle_status: 'cancelado' }, quoteError: null } : prev))
    load()
  }

  // Re-valida el estado contractual justo antes de escribir (la pantalla puede llevar abierta mucho tiempo).
  // Mejor esfuerzo desde el navegador: NO es definitivo ante una cancelación concurrente (Etapas 2 y 3).
  async function ensureWritable() {
    if (!access.canWrite || !service) return false
    const v = await verifyQuoteWritable(supabase, service.quote_id)
    if (v.ok) return true
    setError(v.message)
    if (v.reason === 'cancelled') markCancelled()
    else setCtx((prev) => (prev && prev.id === id ? { ...prev, quoteError: v.message } : prev))
    return false
  }

  const setField = (patch) => {
    if (!access.canWrite) return
    setForm((f) => ({ ...f, ...patch }))
  }

  // Fase 6.7C-1.3c / Etapa 2.1 — muestra el resultado de una llamada a /api/services/*: un solo mensaje, en rojo
  // (error) o en ámbar (guardado con advertencia). Sin reintentos automáticos ni nuevas llamadas a Calendar.
  function report(desc) {
    if (!desc) return
    if (desc.level === 'warning') { setWarning(desc.message); setError('') }
    else { setError(desc.message); setWarning('') }
    if (desc.code === 'CONTRACT_CANCELLED') markCancelled()      // la API confirma la cancelación: la pantalla pasa a solo consulta
  }

  if (access.mode === 'checking') return <div>Cargando…</div>
  if (access.mode === 'service_error') {
    return (
      <div>
        <h2 className="pagetitle">Servicio</h2>
        <div className="panel">
          <div className="muted" style={{ padding: 30, textAlign: 'center' }}>
            <div style={{ marginBottom: 12 }}>No se pudo cargar el servicio.</div>
            <button className="btn ghost small" onClick={() => router.push('/servicios')}>Volver</button>
          </div>
        </div>
      </div>
    )
  }
  if (!form) return <div>Cargando…</div>

  async function handleSave() {
    if (!access.canWrite) return
    setError('')
    setWarning('')
    setSaving(true)
    if (!(await ensureWritable())) { setSaving(false); return }

    if (form.status === 'cancelado') {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/services/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ serviceId: service.id }),
      })
      setSaving(false)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { report(describeServiceApiResult({ ok: false, body }, { fallback: 'No se pudo cancelar.' })); return }
      report(describeServiceApiResult({ ok: true, body }))
      load()
      return
    }

    // "Pendiente de agendar" indica que el cliente todavía no define fecha —
    // no debe quedar ni fecha ni evento en Google Calendar hasta que se
    // vuelva a editar el servicio agregando una nueva fecha y hora. Solo
    // dispara si es un cambio de estatus explícito (venía de otro estatus):
    // si ya estaba pendiente y solo se le agrega fecha, eso sigue el flujo
    // normal de abajo, que lo promueve a "Agendado".
    if (form.status === 'pendiente_agendar' && service.status !== 'pendiente_agendar') {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/services/clear-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ serviceId: service.id }),
      })
      setSaving(false)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { report(describeServiceApiResult({ ok: false, body }, { fallback: 'No se pudo limpiar la fecha y el evento de calendario.' })); return }
      report(describeServiceApiResult({ ok: true, body }))
      load()
      return
    }

    const startAtIso = form.startAt ? new Date(form.startAt).toISOString() : null
    const { error: updateError } = await supabase.from('services').update({
      service_type: form.serviceType,
      address: form.address,
      notes: form.notes,
      duration_value: form.durationValue === '' ? null : form.durationValue,
      duration_unit: form.durationUnit,
      duration_minutes: durationToMinutes(form.durationValue, form.durationUnit) || 60,
      start_at: startAtIso,
      status: form.status === 'pendiente_agendar' && startAtIso ? 'agendado' : form.status,
      updated_at: new Date().toISOString(),
    }).eq('id', service.id)

    if (updateError) { setSaving(false); setError('No se pudo guardar: ' + updateError.message); return }

    if (startAtIso) {
      const ok = await syncCalendar(true)             // el UPDATE del servicio ya se confirmó: una falla aquí es de la sincronización
      if (!ok) { setSaving(false); return }
    }

    setSaving(false)
    load()
  }

  async function syncCalendar(serviceSaved = false) {
    if (!access.canWrite) return false
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/services/sync-calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ serviceId: service.id }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      report(describeServiceApiResult({ ok: false, body }, { genericPrefix: 'No se pudo sincronizar con Google Calendar: ', fallback: 'error desconocido', serviceSaved }))
      return false
    }
    return true
  }

  // Reintento manual de la sincronización con Calendar (banner): también exige contratación vigente confirmada.
  async function retrySync() {
    if (!access.canWrite) return
    setError('')
    setWarning('')
    setSaving(true)
    if (await ensureWritable()) await syncCalendar()
    setSaving(false)
    load()
  }

  const readOnly = !access.canWrite

  return (
    <div>
      <h2 className="pagetitle">{readOnly ? 'Servicio' : 'Editar servicio'}</h2>
      <div className="pagesub">Cotización {quote?.folio || '—'}{quote?.client_name ? ` · ${quote.client_name}` : ''}</div>

      {access.mode === 'readonly' && (
        <div className="editbanner"><span>{CANCELLED_NOTICE}</span></div>
      )}
      {access.mode === 'unverified' && (
        <div className="editbanner">
          <span>{UNVERIFIED_NOTICE}</span>
          <button className="btn ghost small" onClick={() => load()}>Reintentar verificación</button>
        </div>
      )}

      {service.sync_status === 'error' && (
        <div className="editbanner">
          <span>No se pudo sincronizar con Google Calendar: {service.sync_error}</span>
          {!readOnly && <button className="btn ghost small" disabled={saving} onClick={retrySync}>Reintentar</button>}
        </div>
      )}

      <div className="grid2">
        <div>
          <div className="panel">
            <h3>Cliente</h3>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{quote?.client_name || '—'}</div>
            <div className="muted">{quote?.client_phone} {quote?.client_phone && quote?.client_email ? '·' : ''} {quote?.client_email}</div>
          </div>

          <div className="panel">
            <h3>Datos del servicio</h3>
            <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <div className="field">
                <label>Tipo de servicio</label>
                <input value={form.serviceType} onChange={(e) => setField({ serviceType: e.target.value })} />
              </div>
              <div className="fieldrow">
                <div className="field">
                  <label>Fecha y hora</label>
                  <input type="datetime-local" value={form.startAt} onChange={(e) => setField({ startAt: e.target.value })} />
                </div>
                <div className="field">
                  <label>Duración estimada</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="number" min="0" step="0.5" style={{ flex: 1 }}
                      value={form.durationValue}
                      onChange={(e) => setField({ durationValue: e.target.value === '' ? '' : parseFloat(e.target.value) })}
                    />
                    <select
                      style={{ flex: 1 }}
                      value={form.durationUnit}
                      onChange={(e) => setField({ durationUnit: e.target.value })}
                    >
                      <option value="horas">Horas</option>
                      <option value="dias">Días</option>
                    </select>
                  </div>
                </div>
              </div>
              <div className="field">
                <label>Dirección del servicio</label>
                <input value={form.address} onChange={(e) => setField({ address: e.target.value })} />
              </div>
              <div className="field">
                <label>Notas</label>
                <textarea value={form.notes} onChange={(e) => setField({ notes: e.target.value })} />
              </div>
              <div className="field" style={{ maxWidth: 260 }}>
                <label>Estado</label>
                <select value={form.status} onChange={(e) => setField({ status: e.target.value })}>
                  {STATUS_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </div>
            </fieldset>
          </div>

          {error && <div className="fielderr">{error}</div>}
          {warning && <div className="editbanner" style={{ marginTop: 10 }}><span>{warning}</span></div>}
          <div className="actionsbar">
            {!readOnly && <button className="btn teal" disabled={saving} onClick={handleSave}>{saving ? 'Guardando…' : 'Guardar cambios'}</button>}
            <button className="btn ghost" onClick={() => router.push('/servicios')}>Volver</button>
            {service.google_event_link && <a className="btn ghost" href={service.google_event_link} target="_blank" rel="noopener">Ver en Google Calendar</a>}
          </div>
        </div>
      </div>
    </div>
  )
}
