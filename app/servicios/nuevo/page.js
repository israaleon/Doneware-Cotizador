// app/servicios/nuevo/page.js
'use client'
import { useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { durationToMinutes } from '@/lib/serviceStatus'

function toDatetimeLocal(d) {
  if (!d) return ''
  const dt = new Date(d)
  const pad = (n) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

function NuevoServicioInner() {
  const router = useRouter()
  const params = useSearchParams()
  const quoteIdParam = params.get('quoteId')

  const [quote, setQuote] = useState(null)
  const [pickList, setPickList] = useState(null) // cotizaciones contratadas sin servicio, si hay que elegir
  const [form, setForm] = useState({ serviceType: '', startAt: '', durationValue: 1, durationUnit: 'horas', address: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      if (quoteIdParam) {
        const { data } = await supabase.from('quotes').select('*').eq('id', quoteIdParam).single()
        if (data) {
          setQuote(data)
          setForm((f) => ({ ...f, address: data.client_address || '' }))
        }
        return
      }
      // Sin cotización preseleccionada: mostrar las contratadas que aún no tienen servicio.
      const [{ data: contracted }, { data: existingServices }] = await Promise.all([
        supabase.from('quotes').select('*').eq('status', 'cotizacion').eq('contracted', true),
        supabase.from('services').select('quote_id'),
      ])
      const withService = new Set((existingServices || []).map((s) => s.quote_id))
      setPickList((contracted || []).filter((q) => !withService.has(q.id)))
    }
    load()
  }, [quoteIdParam])

  function pickQuote(q) {
    setQuote(q)
    setForm((f) => ({ ...f, address: q.client_address || '' }))
    setPickList(null)
  }

  async function handleSave() {
    if (!quote) return
    setError('')
    setSaving(true)

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
        alert('El servicio se guardó, pero no se pudo sincronizar con Google Calendar: ' + (json.error || 'error desconocido') + '\n\nPuedes reintentar desde la pantalla del servicio.')
      }
    }

    setSaving(false)
    router.push(`/servicios/${created.id}`)
  }

  if (pickList) {
    return (
      <div>
        <h2 className="pagetitle">Agendar servicio</h2>
        <div className="pagesub">Elige la cotización contratada para la que quieres agendar el servicio.</div>
        <div className="panel">
          {!pickList.length ? (
            <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
              No hay cotizaciones contratadas pendientes de agendar. Marca una como "Contratado" desde Historial primero.
            </div>
          ) : (
            pickList.map((q) => (
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
