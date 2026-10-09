// app/servicios/nuevo/page.js
'use client'
import { useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { durationToMinutes } from '@/lib/serviceStatus'
import { loadNewServiceTarget, validateQuoteForNewService, verifyQuoteForNewService } from '@/lib/serviceGuard'
import { newServiceSyncAlertText } from '@/lib/serviceApiMessages'

function toDatetimeLocal(d) {
  if (!d) return ''
  const dt = new Date(d)
  const pad = (n) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

// Clave de la carga actual: distingue "selector" de cada ?quoteId= para no mostrar nunca un resultado de otra URL.
const keyOf = (quoteIdParam) => (quoteIdParam === null ? '__pick__' : quoteIdParam)

function NuevoServicioInner() {
  const router = useRouter()
  const params = useSearchParams()
  const quoteIdParam = params.get('quoteId')

  // Fase 6.7C-1.3c / Etapa 1 — la cotización se valida (UUID, existencia, status='cotizacion' y
  // lifecycle_status='contratado') ANTES de mostrar el formulario; mientras tanto o si falla, no se puede guardar.
  const [target, setTarget] = useState(null)   // { key, kind: 'picklist'|'form'|'blocked'|'error', ... } de la última respuesta
  const [picked, setPicked] = useState(null)   // { key, quote } elegida en el selector
  const [form, setForm] = useState({ serviceType: '', startAt: '', durationValue: 1, durationUnit: 'horas', address: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const key = keyOf(quoteIdParam)
    loadNewServiceTarget(supabase, quoteIdParam).then((r) => {
      if (cancelled) return                       // respuesta rezagada de otra URL: se descarta
      setTarget({ key, ...r })
      if (r.kind === 'form') setForm((f) => ({ ...f, address: r.quote.client_address || '' }))
    })
    return () => { cancelled = true }
  }, [quoteIdParam])

  const ready = target && target.key === keyOf(quoteIdParam) ? target : null
  const pickedHere = picked && picked.key === keyOf(quoteIdParam) ? picked.quote : null
  const quote = pickedHere || (ready && ready.kind === 'form' ? ready.quote : null)

  function pickQuote(q) {
    const v = validateQuoteForNewService(q)
    if (!v.ok) { setError(v.message); return }
    setError('')
    setPicked({ key: keyOf(quoteIdParam), quote: q })
    setForm((f) => ({ ...f, address: q.client_address || '' }))
  }

  async function handleSave() {
    if (!quote) return
    const local = validateQuoteForNewService(quote)
    if (!local.ok) { setError(local.message); return }
    setError('')
    setSaving(true)

    // Re-valida el estado contractual justo antes de insertar (puede haberse cancelado con la pantalla abierta).
    // Mejor esfuerzo desde el navegador: no es definitivo ante una cancelación concurrente (Etapas 2 y 3).
    const check = await verifyQuoteForNewService(supabase, quote.id)
    if (!check.ok) { setSaving(false); setError(check.message); return }

    const startAtIso = form.startAt ? new Date(form.startAt).toISOString() : null
    const payload = {
      quote_id: quote.id,
      client_id: quote.client_id,
      service_type: form.serviceType,
      address: form.address,
      notes: form.notes,
      duration_value: form.durationValue === '' ? null : form.durationValue,
      duration_unit: form.durationUnit,
      duration_minutes: durationToMinutes(form.durationValue, form.durationUnit) || 60,
      start_at: startAtIso,
      status: startAtIso ? 'agendado' : 'pendiente_agendar',
    }

    const { data: { session } } = await supabase.auth.getSession()
    if (startAtIso) payload.calendar_owner = session?.user?.id

    const { data: created, error: insertError } = await supabase.from('services').insert(payload).select().single()

    if (insertError) {
      setSaving(false)
      if (insertError.code === '23505') {
        setError('Esta cotización ya tiene un servicio agendado.')
        const { data: existing } = await supabase.from('services').select('id').eq('quote_id', quote.id).single()
        if (existing) router.push(`/servicios/${existing.id}`)
        return
      }
      setError('No se pudo guardar: ' + insertError.message)
      return
    }

    if (startAtIso) {
      const res = await fetch('/api/services/sync-calendar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ serviceId: created.id }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        // El servicio YA se guardó. alert() es modal: el mensaje (discrepancia, compensación, código) se ve antes de navegar.
        alert(newServiceSyncAlertText(json))
      }
    }

    setSaving(false)
    router.push(`/servicios/${created.id}`)
  }

  if (!ready) return <div>Cargando…</div>

  if (ready.kind === 'blocked' || ready.kind === 'error') {
    return (
      <div>
        <h2 className="pagetitle">Agendar servicio</h2>
        <div className="pagesub">No se puede agendar un servicio para este registro.</div>
        <div className="panel">
          <div className="muted" style={{ padding: 30, textAlign: 'center' }}>
            <div style={{ marginBottom: 12 }}>{ready.message}</div>
            <button className="btn ghost small" onClick={() => router.push('/historial')}>Volver a Historial</button>
          </div>
        </div>
      </div>
    )
  }

  if (ready.kind === 'picklist' && !quote) {
    return (
      <div>
        <h2 className="pagetitle">Agendar servicio</h2>
        <div className="pagesub">Elige la cotización contratada para la que quieres agendar el servicio.</div>
        {error && <div className="fielderr" style={{ marginBottom: 10 }}>{error}</div>}
        <div className="panel">
          {!ready.quotes.length ? (
            <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
              No hay cotizaciones contratadas pendientes de agendar. Marca una como "Contratado" desde Historial primero.
            </div>
          ) : (
            ready.quotes.map((q) => (
              <div key={q.id} className="hist-row" style={{ gridTemplateColumns: '1fr 2fr auto', cursor: 'pointer' }} onClick={() => pickQuote(q)}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{q.folio}</div>
                <div>{q.client_name}</div>
                <button className="btn teal small">Elegir</button>
              </div>
            ))
          )}
        </div>
      </div>
    )
  }

  if (!quote) return <div>Cargando…</div>

  return (
    <div>
      <h2 className="pagetitle">Agendar servicio</h2>
      <div className="pagesub">Cotización {quote.folio} — puedes guardar sin fecha y agendarla después.</div>

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
              <input value={form.serviceType} onChange={(e) => setForm((f) => ({ ...f, serviceType: e.target.value }))} placeholder="Ej. Instalación de cámaras" />
            </div>
            <div className="fieldrow">
              <div className="field">
                <label>Fecha y hora (opcional)</label>
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
              <div className="helptext" style={{ marginTop: 4, marginBottom: 0 }}>Puede ser distinta a la del cliente si el servicio es en otro lugar.</div>
            </div>
            <div className="field">
              <label>Notas</label>
              <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          {error && <div className="fielderr">{error}</div>}
          <div className="actionsbar">
            <button className="btn teal" disabled={saving} onClick={handleSave}>
              {saving ? 'Guardando…' : form.startAt ? 'Agendar servicio' : 'Guardar (pendiente de agendar)'}
            </button>
            <button className="btn ghost" onClick={() => router.push('/historial')}>Cancelar</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function NuevoServicioPage() {
  return <Suspense fallback={<div>Cargando…</div>}><NuevoServicioInner /></Suspense>
}
