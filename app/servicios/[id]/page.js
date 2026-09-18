// app/servicios/[id]/page.js
'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { SERVICE_STATUS_OPTIONS as STATUS_OPTIONS, durationToMinutes, minutesToDuration } from '@/lib/serviceStatus'

function toDatetimeLocal(d) {
  if (!d) return ''
  const dt = new Date(d)
  const pad = (n) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

export default function EditarServicioPage() {
  const { id } = useParams()
  const router = useRouter()
  const [service, setService] = useState(null)
  const [quote, setQuote] = useState(null)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    const { data: svc } = await supabase.from('services').select('*').eq('id', id).single()
    if (!svc) return
    setService(svc)
    const duration = svc.duration_value != null
      ? { value: svc.duration_value, unit: svc.duration_unit || 'horas' }
      : minutesToDuration(svc.duration_minutes)
    setForm({
      serviceType: svc.service_type || '',
      startAt: toDatetimeLocal(svc.start_at),
      durationValue: duration.value,
      durationUnit: duration.unit,
      address: svc.address || '',
      notes: svc.notes || '',
      status: svc.status,
    })
    const { data: q } = await supabase.from('quotes').select('*').eq('id', svc.quote_id).single()
    setQuote(q)
  }
  useEffect(() => { load() }, [id])

  if (!service || !quote || !form) return <div>Cargando…</div>

  async function handleSave() {
    setError('')
    setSaving(true)

    if (form.status === 'cancelado') {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/services/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ serviceId: service.id }),
      })
      setSaving(false)
      if (!res.ok) { const j = await res.json().catch(() => ({})); setError(j.error || 'No se pudo cancelar.'); return }
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
      if (!res.ok) { const j = await res.json().catch(() => ({})); setError(j.error || 'No se pudo limpiar la fecha y el evento de calendario.'); return }
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
      const ok = await syncCalendar()
      if (!ok) { setSaving(false); return }
    }

    setSaving(false)
    load()
  }

  async function syncCalendar() {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/services/sync-calendar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ serviceId: service.id }),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => ({}))
      setError('No se pudo sincronizar con Google Calendar: ' + (json.error || 'error desconocido'))
      return false
    }
    return true
  }

  return (
    <div>
      <h2 className="pagetitle">Editar servicio</h2>
      <div className="pagesub">Cotización {quote.folio} · {quote.client_name}</div>

      {service.sync_status === 'error' && (
        <div className="editbanner">
          <span>No se pudo sincronizar con Google Calendar: {service.sync_error}</span>
          <button className="btn ghost small" onClick={async () => { setSaving(true); await syncCalendar(); setSaving(false); load() }}>Reintentar</button>
        </div>
      )}

      <div className="grid2">
        <div>
          <div className="panel">
            <h3>Cliente</h3>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{quote.client_name}</div>
            <div className="muted">{quote.client_phone} {quote.client_phone && quote.client_email ? '·' : ''} {quote.client_email}</div>
          </div>

          <div className="panel">
            <h3>Datos del servicio</h3>
            <div className="field">
              <label>Tipo de servicio</label>
              <input value={form.serviceType} onChange={(e) => setForm((f) => ({ ...f, serviceType: e.target.value }))} />
            </div>
            <div className="fieldrow">
              <div className="field">
                <label>Fecha y hora</label>
                <input type="datetime-local" value={form.startAt} onChange={(e) => setForm((f) => ({ ...f, startAt: e.target.value }))} />
              </div>
              <div className="field">
                <label>Duración estimada</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="number" min="0" step="0.5" style={{ flex: 1 }}
                    value={form.durationValue}
                    onChange={(e) => setForm((f) => ({ ...f, durationValue: e.target.value === '' ? '' : parseFloat(e.target.value) }))}
                  />
                  <select
                    style={{ flex: 1 }}
                    value={form.durationUnit}
                    onChange={(e) => setForm((f) => ({ ...f, durationUnit: e.target.value }))}
                  >
                    <option value="horas">Horas</option>
                    <option value="dias">Días</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="field">
              <label>Dirección del servicio</label>
              <input value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
            </div>
            <div className="field">
              <label>Notas</label>
              <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
            <div className="field" style={{ maxWidth: 260 }}>
              <label>Estado</label>
              <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}>
                {STATUS_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </div>
          </div>

          {error && <div className="fielderr">{error}</div>}
          <div className="actionsbar">
            <button className="btn teal" disabled={saving} onClick={handleSave}>{saving ? 'Guardando…' : 'Guardar cambios'}</button>
            <button className="btn ghost" onClick={() => router.push('/servicios')}>Volver</button>
            {service.google_event_link && <a className="btn ghost" href={service.google_event_link} target="_blank" rel="noopener">Ver en Google Calendar</a>}
          </div>
        </div>
      </div>
    </div>
  )
}
