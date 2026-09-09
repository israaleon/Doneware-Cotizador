// app/historial/page.js
'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { fmt, makeFolio, isValidEmail, isValidPhone10 } from '@/lib/calc'
import { fillTemplate } from '@/lib/templates'
import { buildPdfDoc } from '@/lib/pdf'

const PAGE_SIZE = 20

export default function HistorialPage() {
  const [quotes, setQuotes] = useState([])
  const [config, setConfig] = useState(null)
  const [searchText, setSearchText] = useState('')
  const [searchDate, setSearchDate] = useState('')
  const [typeFilter, setTypeFilter] = useState('all') // all | cotizacion | recibo
  const [page, setPage] = useState(1)
  const router = useRouter()

  async function load() {
    const [{ data: q }, { data: cfg }] = await Promise.all([
      supabase.from('quotes').select('*').order('created_at', { ascending: false }),
      supabase.from('app_config').select('*').eq('id', 1).single(),
    ])
    setQuotes(q || [])
    setConfig(cfg)
  }
  useEffect(() => { load() }, [])

  // Cada vez que cambia un filtro, regresamos a la página 1.
  useEffect(() => { setPage(1) }, [searchText, searchDate, typeFilter])

  const filtered = useMemo(() => {
    const text = searchText.trim().toLowerCase()
    return quotes.filter((q) => {
      if (typeFilter !== 'all' && q.status !== typeFilter) return false
      if (text) {
        const haystack = `${q.client_name || ''} ${q.folio || ''}`.toLowerCase()
        if (!haystack.includes(text)) return false
      }
      if (searchDate) {
        const qDate = new Date(q.created_at).toISOString().slice(0, 10)
        if (qDate !== searchDate) return false
      }
      return true
    })
  }, [quotes, searchText, searchDate, typeFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  if (!config) return <div>Cargando…</div>

  async function downloadPdf(rec) {
    const doc = await buildPdfDoc(rec, config)
    doc.save(rec.folio + '.pdf')
  }

  async function sendByEmail(rec) {
    let email = rec.client_email
    if (!isValidEmail(email)) {
      email = window.prompt('Escribe un correo válido para el cliente (ejemplo: nombre@dominio.com):', email || '')
      if (!email) return
      if (!isValidEmail(email)) { alert('Ese correo no tiene un formato válido.'); return }
    }
    await downloadPdf(rec)
    const isReceipt = rec.status === 'recibo'
    const subjectTpl = isReceipt ? config.receipt_email_subject_template : config.email_subject_template
    const bodyTpl = isReceipt ? config.receipt_email_body_template : config.email_body_template
    const subject = fillTemplate(subjectTpl, rec, config)
    const body = fillTemplate(bodyTpl, rec, config)
    window.location.href = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }

  async function sendByWhatsapp(rec) {
    let digits = (rec.client_phone || '').replace(/\D/g, '')
    if (!isValidPhone10(digits)) {
      const input = window.prompt('Escribe el teléfono del cliente (10 dígitos):', digits || '')
      if (!input) return
      digits = input.replace(/\D/g, '')
      if (!isValidPhone10(digits)) { alert('El teléfono debe tener exactamente 10 dígitos.'); return }
    }
    await downloadPdf(rec)
    const isReceipt = rec.status === 'recibo'
    const waTpl = isReceipt ? config.receipt_whatsapp_template : config.whatsapp_template
    const text = fillTemplate(waTpl, rec, config)
    window.open(`https://wa.me/52${digits}?text=${encodeURIComponent(text)}`, '_blank')
  }

  async function convertToReceipt(src) {
    const folio = makeFolio('recibo', config)
    const payload = {
      folio,
      status: 'recibo',
      related_folio: src.folio,
      client_name: src.client_name, client_phone: src.client_phone, client_email: src.client_email, client_address: src.client_address,
      items: src.items, discount_type: src.discount_type, discount_value: src.discount_value,
      notes: src.notes, valid_days: src.valid_days,
      subtotal: src.subtotal, discount: src.discount, iva: src.iva, iva_rate: src.iva_rate, apply_iva: src.apply_iva, total: src.total,
    }
    const { data: rec, error } = await supabase.from('quotes').insert(payload).select().single()
    if (error) { alert('No se pudo generar el recibo: ' + error.message); return }
    await supabase.from('app_config').update({ next_receipt_number: config.next_receipt_number + 1 }).eq('id', 1)
    await load()
    await downloadPdf(rec)
  }

  async function deleteRecord(rec) {
    const tipo = rec.status === 'recibo' ? 'el recibo' : 'la cotización'
    const ok = window.confirm(
      `¿Seguro que deseas eliminar ${tipo} ${rec.folio}?\n\nEsta acción no se puede deshacer: una vez borrado no podrás recuperarlo.`
    )
    if (!ok) return
    const { error } = await supabase.from('quotes').delete().eq('id', rec.id)
    if (error) { alert('No se pudo eliminar: ' + error.message); return }
    load()
  }

  return (
    <div>
      <h2 className="pagetitle">Historial</h2>
      <div className="pagesub">Todas tus cotizaciones y recibos.</div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Buscar por nombre o folio</label>
            <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Ej. Juan Pérez o COT-2026-0001" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Fecha</label>
            <input type="date" value={searchDate} onChange={(e) => setSearchDate(e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Tipo</label>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="all">Todos</option>
              <option value="cotizacion">Cotización</option>
              <option value="recibo">Recibo</option>
            </select>
          </div>
        </div>
      </div>

      {!filtered.length ? (
        <div className="panel"><div className="muted" style={{ padding: 30, textAlign: 'center' }}>
          {quotes.length ? 'No hay resultados con esos filtros.' : 'Todavía no has generado ninguna cotización.'}
        </div></div>
      ) : (
        <>
          <div className="panel" style={{ padding: '6px 12px' }}>
            {pageItems.map((q) => (
              <div className="hist-row" key={q.id}>
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{q.folio}</div>
                  <div className="muted">{new Date(q.created_at).toLocaleDateString('es-MX')}</div>
                </div>
                <div>
                  <div>{q.client_name}</div>
                  <div className="muted">{q.client_phone}</div>
                </div>
                <div style={{ fontFamily: 'var(--mono)' }}>{fmt(q.total)}</div>
                <div><span className={`badge ${q.status === 'recibo' ? 'rec' : 'cot'}`}>{q.status === 'recibo' ? 'RECIBO' : 'COTIZACIÓN'}</span></div>
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <button className="btn ghost small" onClick={() => downloadPdf(q)}>PDF</button>
                  <button className="btn ghost small" onClick={() => sendByEmail(q)}>Correo</button>
                  <button className="btn ghost small" onClick={() => sendByWhatsapp(q)}>WhatsApp</button>
                  {q.status === 'cotizacion' && (
                    <button className="btn ghost small" onClick={() => router.push(`/cotizar?edit=${q.id}`)}>Editar</button>
                  )}
                  {q.status === 'cotizacion' && (
                    <button className="btn teal small" onClick={() => convertToReceipt(q)}>Marcar contratado</button>
                  )}
                  <button className="iconbtn" title="Eliminar" onClick={() => deleteRecord(q)}>✕</button>
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
            <div className="muted">
              {filtered.length} resultado{filtered.length === 1 ? '' : 's'} · página {page} de {totalPages}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn ghost small" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Anterior</button>
              <button className="btn ghost small" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Siguiente →</button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
