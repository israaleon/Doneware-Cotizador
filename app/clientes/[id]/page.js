// app/clientes/[id]/page.js
'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { fmt } from '@/lib/calc'
import { buildPdfDoc } from '@/lib/pdf'
import { SERVICE_STATUS_LABEL, SERVICE_STATUS_BADGE } from '@/lib/serviceStatus'

export default function ClienteDetallePage() {
  const { id } = useParams()
  const router = useRouter()
  const [client, setClient] = useState(null)
  const [config, setConfig] = useState(null)
  const [quotes, setQuotes] = useState([]) // solo las de tipo 'cotizacion' de este cliente
  const [receiptsByFolio, setReceiptsByFolio] = useState({})
  const [servicesByQuote, setServicesByQuote] = useState({})
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(null)

  async function load() {
    const [{ data: c }, { data: cfg }] = await Promise.all([
      supabase.from('clients').select('*').eq('id', id).single(),
      supabase.from('app_config').select('*').eq('id', 1).single(),
    ])
    setClient(c)
    setConfig(cfg)
    if (c) setForm({ name: c.name || '', phone: c.phone || '', email: c.email || '', address: c.address || '' })
    if (!c) return

    const { data: qs } = await supabase.from('quotes').select('*').eq('client_id', id).eq('status', 'cotizacion').order('created_at', { ascending: false })
    setQuotes(qs || [])

    const folios = (qs || []).map((q) => q.folio)
    if (folios.length) {
      const { data: recs } = await supabase.from('quotes').select('*').eq('status', 'recibo').in('related_folio', folios)
      const map = {}
      ;(recs || []).forEach((r) => { map[r.related_folio] = r })
      setReceiptsByFolio(map)
    }

    const quoteIds = (qs || []).map((q) => q.id)
    if (quoteIds.length) {
      const { data: svcs } = await supabase.from('services').select('*').in('quote_id', quoteIds)
      const map = {}
      ;(svcs || []).forEach((s) => { map[s.quote_id] = s })
      setServicesByQuote(map)
    }
  }
  useEffect(() => { load() }, [id])

  if (!client || !config) return <div>Cargando…</div>

  async function saveClient() {
    await supabase.from('clients').update({ ...form, updated_at: new Date().toISOString() }).eq('id', id)
    setEditing(false)
    load()
  }

  async function downloadPdf(rec) {
    const doc = await buildPdfDoc(rec, config)
    doc.save(rec.folio + '.pdf')
  }

  return (
    <div>
      <h2 className="pagetitle">{client.name}</h2>
      <div className="pagesub">Cliente desde {new Date(client.created_at).toLocaleDateString('es-MX')}</div>

      <div className="grid2">
        <div>
          <div className="panel">
            <h3>Datos del cliente</h3>
            {editing ? (
              <>
                <div className="fieldrow">
                  <div className="field"><label>Nombre</label><input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
                  <div className="field"><label>Teléfono</label><input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} /></div>
                </div>
                <div className="fieldrow">
                  <div className="field"><label>Correo</label><input value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></div>
                  <div className="field"><label>Dirección</label><input value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} /></div>
                </div>
                <div className="actionsbar" style={{ marginTop: 0 }}>
                  <button className="btn teal small" onClick={saveClient}>Guardar</button>
                  <button className="btn ghost small" onClick={() => setEditing(false)}>Cancelar</button>
                </div>
              </>
            ) : (
              <>
                <div className="muted">Teléfono: {client.phone || '—'}</div>
                <div className="muted">Correo: {client.email || '—'}</div>
                <div className="muted">Dirección: {client.address || '—'}</div>
                <div className="actionsbar">
                  <button className="btn ghost small" onClick={() => setEditing(true)}>Editar cliente</button>
                  <button className="btn teal small" onClick={() => router.push(`/cotizar?client=${id}`)}>+ Nueva cotización</button>
                </div>
              </>
            )}
            <div className="helptext" style={{ marginTop: 10, marginBottom: 0 }}>
              Editar aquí no cambia las cotizaciones ya generadas — cada una conserva su propia copia de estos datos tal como
              estaban en ese momento.
            </div>
          </div>

          <div className="panel">
            <h3>Historial de este cliente</h3>
            {!quotes.length ? (
              <div className="muted" style={{ padding: 20, textAlign: 'center' }}>Todavía no tiene cotizaciones.</div>
            ) : (
              quotes.map((q) => {
                const receipt = receiptsByFolio[q.folio]
                const service = servicesByQuote[q.id]
                return (
                  <div className="hist-row" key={q.id} style={{ gridTemplateColumns: '1fr 1fr .8fr auto' }}>
                    <div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{q.folio}</div>
                      <div className="muted">{new Date(q.created_at).toLocaleDateString('es-MX')}</div>
                    </div>
                    <div style={{ fontFamily: 'var(--mono)' }}>{fmt(q.total)}</div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <span className={`badge ${q.contracted ? 'rec' : 'cot'}`}>{q.contracted ? 'CONTRATADO' : 'PENDIENTE'}</span>
                      {receipt && <span className="badge rec">RECIBO</span>}
                      {service && <span className={`badge ${SERVICE_STATUS_BADGE[service.status]}`}>{SERVICE_STATUS_LABEL[service.status]}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn ghost small" onClick={() => downloadPdf(q)}>PDF</button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
