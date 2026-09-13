// app/cotizador-productos/page.js
'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { fmt } from '@/lib/calc'
import ProductTabs from '@/components/ProductTabs'

export default function CotizadorProductosPage() {
  const [products, setProducts] = useState([])
  const [config, setConfig] = useState(null)
  const [url, setUrl] = useState('')
  const [preview, setPreview] = useState(null) // resultado de /api/ml-lookup antes de guardar
  const [looking, setLooking] = useState(false)
  const [lookupError, setLookupError] = useState('')

  async function load() {
    const [{ data: p }, { data: cfg }] = await Promise.all([
      supabase.from('tracked_products').select('*').order('created_at', { ascending: false }),
      supabase.from('app_config').select('*').eq('id', 1).single(),
    ])
    setProducts(p || [])
    setConfig(cfg)
  }
  useEffect(() => { load() }, [])

  async function handleLookup() {
    if (!url.trim()) return
    setLooking(true)
    setLookupError('')
    setPreview(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/ml-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ url }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'No se pudo consultar el producto.')
      setPreview(json)
    } catch (err) {
      setLookupError(err.message)
    } finally {
      setLooking(false)
    }
  }

  async function handleSave() {
    if (!preview) return
    const { data: saved, error } = await supabase.from('tracked_products').insert({
      name: preview.title,
      ml_url: preview.permalink,
      ml_item_id: preview.itemId,
      thumbnail: preview.thumbnail,
      initial_price: preview.price,
      current_price: preview.price,
      last_checked_at: new Date().toISOString(),
    }).select().single()

    if (error) {
      alert(error.code === '23505'
        ? 'Ese producto ya está registrado.'
        : 'No se pudo guardar: ' + error.message)
      return
    }
    // primer punto del historial
    await supabase.from('price_history').insert({ product_id: saved.id, price: preview.price })

    setUrl(''); setPreview(null)
    load()
  }

  async function deleteProduct(p) {
    const ok = window.confirm(`¿Seguro que deseas dejar de rastrear "${p.name}"?\n\nSe borrará también su historial de precios. Esta acción no se puede deshacer.`)
    if (!ok) return
    const { error } = await supabase.from('tracked_products').delete().eq('id', p.id)
    if (error) { alert('No se pudo eliminar: ' + error.message); return }
    load()
  }

  async function syncCatalog(p) {
    const suggested = suggestedPrice(p)
    const { data: matches } = await supabase
      .from('catalog_items')
      .select('*')
      .ilike('name', `%${p.name.split(' ').slice(0, 3).join(' ')}%`)

    if (!matches || !matches.length) {
      alert('No encontré ningún producto del catálogo con un nombre parecido a este. Puedes actualizarlo manualmente en "Catálogo y precios".')
      return
    }
    const names = matches.map((m) => `• ${m.name} ($${m.price} → $${suggested.toFixed(2)})`).join('\n')
    const ok = window.confirm(`Se actualizará el precio a ${fmt(suggested)} en estos productos del catálogo:\n\n${names}\n\n¿Continuar?`)
    if (!ok) return
    await Promise.all(matches.map((m) => supabase.from('catalog_items').update({ price: suggested }).eq('id', m.id)))
    alert('Catálogo actualizado.')
  }

  function suggestedPrice(p) {
    const margin = config?.quote_margin_percent ?? 20
    return p.current_price * (1 + margin / 100)
  }

  return (
    <div>
      <h2 className="pagetitle">Cotizador de productos</h2>
      <div className="pagesub">Rastrea el precio de tus productos en Mercado Libre y detecta cambios automáticamente.</div>
      <ProductTabs />

      <div className="panel">
        <h3>Registrar producto</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Pega la URL del producto en Mercado Libre" style={{ flex: 1 }} />
          <button className="btn teal small" onClick={handleLookup} disabled={looking} style={{ flex: '0 0 auto' }}>
            {looking ? 'Buscando…' : 'Buscar'}
          </button>
        </div>
        {lookupError && <div className="fielderr">{lookupError}</div>}

        {preview && (
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 14, padding: 12, border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            {preview.thumbnail && <img src={preview.thumbnail} alt="" style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 6 }} />}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{preview.title}</div>
              <div className="muted" style={{ fontFamily: 'var(--mono)' }}>{fmt(preview.price)} · {preview.status === 'active' ? 'publicado' : preview.status}</div>
            </div>
            <button className="btn teal small" onClick={handleSave}>+ Empezar a rastrear</button>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>Productos rastreados</h3>
        {!products.length ? (
          <div className="muted" style={{ padding: 20, textAlign: 'center' }}>Todavía no registras ningún producto.</div>
        ) : (
          <div className="table-scroll">
            <table className="datatable">
              <thead>
                <tr>
                  <th>Producto</th><th>Inicial</th><th>Actual</th><th>Diferencia</th><th>Sugerido</th><th>Última revisión</th><th></th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const diff = p.current_price - p.initial_price
                  const diffPct = p.initial_price ? (diff / p.initial_price) * 100 : 0
                  const color = diff > 0 ? 'var(--red)' : diff < 0 ? 'var(--teal-dark)' : 'var(--steel)'
                  return (
                    <tr key={p.id}>
                      <td>
                        <a href={p.ml_url} target="_blank" rel="noopener" style={{ color: 'var(--ink)', textDecoration: 'none' }}>{p.name}</a>
                      </td>
                      <td style={{ fontFamily: 'var(--mono)' }}>{fmt(p.initial_price)}</td>
                      <td style={{ fontFamily: 'var(--mono)' }}>{fmt(p.current_price)}</td>
                      <td style={{ fontFamily: 'var(--mono)', color }}>
                        {diff === 0 ? 'sin cambio' : `${diff > 0 ? '+' : ''}${fmt(diff)} (${diffPct > 0 ? '+' : ''}${diffPct.toFixed(1)}%)`}
                      </td>
                      <td style={{ fontFamily: 'var(--mono)' }}>{fmt(suggestedPrice(p))}</td>
                      <td className="muted">{p.last_checked_at ? new Date(p.last_checked_at).toLocaleDateString('es-MX') : '—'}</td>
                      <td style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn ghost small" onClick={() => syncCatalog(p)}>Actualizar catálogo</button>
                        <button className="iconbtn" title="Eliminar" onClick={() => deleteProduct(p)}>✕</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
