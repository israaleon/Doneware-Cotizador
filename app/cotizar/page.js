// app/cotizar/page.js
'use client'
import { useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { fmt, calcTotals, validateQuote } from '@/lib/calc'
import { nextFolio } from '@/lib/folio'
import { buildPdfDoc } from '@/lib/pdf'

function newDraft(config) {
  return {
    client: { name: '', phone: '', email: '', address: '' },
    items: [],
    discountType: 'percent',
    discountValue: 0,
    notes: '',
    validDays: config?.valid_days || 15,
  }
}

// Campos opcionales que, si quedan vacíos, generan una advertencia (no un
// bloqueo) antes de guardar.
const OPTIONAL_FIELDS = [
  { get: (d) => d.client.phone, label: 'Teléfono del cliente' },
  { get: (d) => d.client.email, label: 'Correo del cliente' },
  { get: (d) => d.client.address, label: 'Dirección' },
  { get: (d) => d.notes, label: 'Notas para el cliente' },
]

function missingOptionalFields(draft) {
  return OPTIONAL_FIELDS.filter((f) => !String(f.get(draft) || '').trim()).map((f) => f.label)
}

function CotizarInner() {
  const router = useRouter()
  const params = useSearchParams()
  const editId = params.get('edit') // /cotizar?edit=<uuid> para editar un registro existente

  const [config, setConfig] = useState(null)
  const [catalog, setCatalog] = useState([])
  const [draft, setDraft] = useState(null)
  const [errors, setErrors] = useState({})
  const [editingRec, setEditingRec] = useState(null)
  const [saving, setSaving] = useState(false)
  const [selectedCatalogId, setSelectedCatalogId] = useState('')
  const [justAddedIdx, setJustAddedIdx] = useState(null)
  const [previewFolio, setPreviewFolio] = useState('')

  useEffect(() => {
    async function load() {
      const [{ data: cfg }, { data: cat }] = await Promise.all([
        supabase.from('app_config').select('*').eq('id', 1).single(),
        supabase.from('catalog_items').select('*').eq('active', true).order('name'),
      ])
      setConfig(cfg)
      setCatalog(cat || [])

      if (editId) {
        const { data: rec } = await supabase.from('quotes').select('*').eq('id', editId).single()
        if (rec) {
          setEditingRec(rec)
          setDraft({
            client: { name: rec.client_name || '', phone: rec.client_phone || '', email: rec.client_email || '', address: rec.client_address || '' },
            items: rec.items || [],
            discountType: rec.discount_type,
            discountValue: rec.discount_value,
            notes: rec.notes || '',
            validDays: rec.valid_days,
          })
          return
        }
      }
      setDraft(newDraft(cfg))
      setPreviewFolio(await nextFolio('cotizacion'))
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId])

  useEffect(() => {
    if (justAddedIdx === null) return
    const t = setTimeout(() => setJustAddedIdx(null), 1200)
    return () => clearTimeout(t)
  }, [justAddedIdx])

  if (!draft || !config) return <div>Cargando…</div>

  const totals = calcTotals(draft.items, draft.discountType, draft.discountValue, config.apply_iva, config.iva_rate)
  const displayFolio = editingRec ? editingRec.folio : (previewFolio || '…')

  function updateClient(field, value) {
    setDraft((d) => ({ ...d, client: { ...d.client, [field]: value } }))
  }
  function addFromCatalog(catalogId) {
    const p = catalog.find((c) => c.id === catalogId)
    if (!p) return
    setDraft((d) => {
      const items = [...d.items, { name: p.name, price: p.price, qty: 1 }]
      setJustAddedIdx(items.length - 1)
      return { ...d, items }
    })
  }
  function addBlankItem() {
    setDraft((d) => ({ ...d, items: [...d.items, { name: '', price: '', qty: 1 }] }))
  }
  function updateItem(idx, field, value) {
    setDraft((d) => {
      const items = d.items.slice()
      items[idx] = { ...items[idx], [field]: value }
      return { ...d, items }
    })
  }
  function removeItem(idx) {
    setDraft((d) => ({ ...d, items: d.items.filter((_, i) => i !== idx) }))
  }

  async function handleSubmit() {
    const { errors: errs, hasErrors } = validateQuote(draft)
    setErrors(errs)
    if (hasErrors) return

    // Aviso (no bloqueo) por campos opcionales vacíos: teléfono, correo,
    // dirección, notas. Si el usuario cancela, no se guarda nada.
    const missing = missingOptionalFields(draft)
    if (missing.length) {
      const ok = window.confirm(
        `Los siguientes campos no fueron llenados:\n\n• ${missing.join('\n• ')}\n\n` +
        `¿Deseas continuar de todas formas, o prefieres Cancelar para completarlos?`
      )
      if (!ok) return
    }

    await saveQuote()
  }

  async function saveQuote() {
    setSaving(true)
    const t = calcTotals(draft.items, draft.discountType, draft.discountValue, config.apply_iva, config.iva_rate)
    const payload = {
      client_name: draft.client.name,
      client_phone: draft.client.phone,
      client_email: draft.client.email,
      client_address: draft.client.address,
      items: draft.items,
      discount_type: draft.discountType,
      discount_value: draft.discountValue,
      notes: draft.notes,
      valid_days: draft.validDays,
      subtotal: t.subtotal,
      discount: t.discount,
      iva: t.iva,
      iva_rate: config.iva_rate,
      apply_iva: config.apply_iva,
      total: t.total,
    }

    let rec
    if (editingRec) {
      const { data, error } = await supabase.from('quotes').update(payload).eq('id', editingRec.id).select().single()
      if (error) { alert('No se pudo guardar: ' + error.message); setSaving(false); return }
      rec = data
    } else {
      const folio = await nextFolio('cotizacion')
      const { data, error } = await supabase.from('quotes').insert({ ...payload, folio, status: 'cotizacion' }).select().single()
      if (error) { alert('No se pudo guardar: ' + error.message); setSaving(false); return }
      rec = data
    }

    const doc = await buildPdfDoc(rec, config)
    doc.save(rec.folio + '.pdf')

    setSaving(false)
    router.push('/historial')
  }

  const itemErr = (idx, field) => errors.itemErrors?.[idx]?.[field]

  return (
    <div>
      <h2 className="pagetitle">{editingRec ? `Editar ${editingRec.status === 'recibo' ? 'recibo' : 'cotización'}` : 'Nueva cotización'}</h2>
      <div className="pagesub">Llena los datos del cliente, agrega productos/servicios del catálogo y genera el PDF.</div>

      {editingRec && (
        <div className="editbanner">
          <span>Estás editando <strong>{editingRec.folio}</strong>. Al guardar se actualiza ese mismo registro.</span>
          <button className="btn ghost small" onClick={() => router.push('/historial')}>Cancelar edición</button>
        </div>
      )}

      <div className="grid2">
        <div>
          <div className="panel">
            <h3>Datos del cliente</h3>
            <div className="fieldrow">
              <div className="field">
                <label>Nombre / empresa</label>
                <input className={errors.name ? 'input-error' : ''} value={draft.client.name} onChange={(e) => updateClient('name', e.target.value)} />
                {errors.name && <div className="fielderr">{errors.name}</div>}
              </div>
              <div className="field">
                <label>Teléfono (10 dígitos)</label>
                <input className={errors.phone ? 'input-error' : ''} maxLength={10} value={draft.client.phone}
                  onChange={(e) => updateClient('phone', e.target.value.replace(/\D/g, '').slice(0, 10))} />
                {errors.phone && <div className="fielderr">{errors.phone}</div>}
              </div>
            </div>
            <div className="fieldrow">
              <div className="field">
                <label>Correo</label>
                <input className={errors.email ? 'input-error' : ''} value={draft.client.email} onChange={(e) => updateClient('email', e.target.value)} placeholder="nombre@dominio.com" />
                {errors.email && <div className="fielderr">{errors.email}</div>}
              </div>
              <div className="field">
                <label>Dirección</label>
                <input value={draft.client.address} onChange={(e) => updateClient('address', e.target.value)} />
              </div>
            </div>
          </div>

          <div className="panel">
            <h3>Productos y servicios</h3>
            <div className="field">
              <label>Agregar desde catálogo</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <select value={selectedCatalogId} onChange={(e) => setSelectedCatalogId(e.target.value)} style={{ flex: 1 }}>
                  <option value="">— elegir del catálogo —</option>
                  {catalog.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} · {fmt(c.price)}</option>
                  ))}
                </select>
                <button
                  className="btn teal small"
                  style={{ flex: '0 0 auto' }}
                  disabled={!selectedCatalogId}
                  onClick={() => { addFromCatalog(selectedCatalogId) }}
                >
                  + Agregar
                </button>
              </div>
              <div className="helptext" style={{ marginTop: 6, marginBottom: 0 }}>
                El producto elegido se queda marcado en la lista; da clic en "+ Agregar" cada vez que quieras añadirlo (puedes agregarlo varias veces si necesitas más de una unidad como líneas separadas).
              </div>
            </div>
            {errors.items && <div className="fielderr">{errors.items}</div>}
            {draft.items.map((it, idx) => (
              <div key={idx} className={`item-row ${idx === justAddedIdx ? 'just-added' : ''}`}>
                <div className="f-name">
                  <input className={itemErr(idx, 'name') ? 'input-error' : ''} value={it.name} placeholder="Descripción"
                    onChange={(e) => updateItem(idx, 'name', e.target.value)} />
                  {itemErr(idx, 'name') && <div className="fielderr">{itemErr(idx, 'name')}</div>}
                </div>
                <div className="f-price">
                  <input className={itemErr(idx, 'price') ? 'input-error' : ''} type="number" min="0" step="0.01" value={it.price}
                    onChange={(e) => updateItem(idx, 'price', e.target.value === '' ? '' : parseFloat(e.target.value))} />
                  {itemErr(idx, 'price') && <div className="fielderr">{itemErr(idx, 'price')}</div>}
                </div>
                <div className="f-qty">
                  <input className={itemErr(idx, 'qty') ? 'input-error' : ''} type="number" min="1" step="1" value={it.qty}
                    onChange={(e) => updateItem(idx, 'qty', e.target.value === '' ? '' : parseInt(e.target.value))} />
                  {itemErr(idx, 'qty') && <div className="fielderr">{itemErr(idx, 'qty')}</div>}
                </div>
                <div className="f-importe">{fmt((it.price || 0) * (it.qty || 0))}</div>
                <button className="iconbtn f-del" onClick={() => removeItem(idx)}>✕</button>
              </div>
            ))}
            <button className="btn ghost small" onClick={addBlankItem}>+ Agregar línea libre</button>
          </div>

          <div className="panel">
            <h3>Descuento, vigencia y notas</h3>
            <div className="fieldrow">
              <div className="field">
                <label>Descuento</label>
                <select value={draft.discountType} onChange={(e) => setDraft((d) => ({ ...d, discountType: e.target.value }))}>
                  <option value="percent">Porcentaje (%)</option>
                  <option value="amount">Monto fijo ($)</option>
                </select>
              </div>
              <div className="field">
                <label>Valor</label>
                <input className={errors.discount ? 'input-error' : ''} type="number" min="0" step="0.01" value={draft.discountValue}
                  onChange={(e) => setDraft((d) => ({ ...d, discountValue: e.target.value === '' ? '' : parseFloat(e.target.value) }))} />
                {errors.discount && <div className="fielderr">{errors.discount}</div>}
              </div>
            </div>
            <div className="field" style={{ maxWidth: 200 }}>
              <label>Vigencia (días)</label>
              <input type="number" min="1" value={draft.validDays} onChange={(e) => setDraft((d) => ({ ...d, validDays: parseInt(e.target.value) || 1 }))} />
            </div>
            <div className="field">
              <label>Notas para el cliente (opcional)</label>
              <textarea value={draft.notes} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
            </div>
          </div>
        </div>

        <div>
          <div className="ticket">
            <div className="ticket-head">
              {config.logo_url && <img src={config.logo_url} alt="" style={{ width: 30, height: 30, objectFit: 'contain', background: '#fff', borderRadius: 3, padding: 2 }} />}
              <div>
                <div className="co">{config.company_name}</div>
                <div className="meta">FOLIO {displayFolio} · VIGENCIA {draft.validDays} DÍAS</div>
              </div>
            </div>
            <div className="ticket-body">
              {draft.items.length ? draft.items.map((it, idx) => (
                <div className="ticket-line" key={idx}>
                  <span>{it.name || '—'} <span className="muted">×{it.qty || 0}</span></span>
                  <span>{fmt((it.price || 0) * (it.qty || 0))}</span>
                </div>
              )) : <div className="ticket-line"><span className="muted">Sin productos aún</span><span></span></div>}
            </div>
            <div className="ticket-totals">
              <div className="trow"><span>Subtotal</span><span>{fmt(totals.subtotal)}</span></div>
              {totals.discount > 0 && <div className="trow"><span>Descuento</span><span>-{fmt(totals.discount)}</span></div>}
              {config.apply_iva && <div className="trow"><span>IVA ({config.iva_rate}%)</span><span>{fmt(totals.iva)}</span></div>}
              <div className="trow total"><span>Total</span><span>{fmt(totals.total)}</span></div>
            </div>
          </div>
          <div className="actionsbar">
            <button className="btn teal" disabled={saving} onClick={handleSubmit}>
              {saving ? 'Guardando…' : editingRec ? 'Guardar cambios' : 'Generar cotización PDF'}
            </button>
            <button className="btn ghost" onClick={() => router.push('/historial')}>Cancelar</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function CotizarPage() {
  return (
    <Suspense fallback={<div>Cargando…</div>}>
      <CotizarInner />
    </Suspense>
  )
}
