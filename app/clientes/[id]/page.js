// app/clientes/[id]/page.js
'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { fmt } from '@/lib/calc'
import { triggerPdfDownload, resolveQuoteDownload } from '@/lib/pdf'
import { SERVICE_STATUS_LABEL, SERVICE_STATUS_BADGE } from '@/lib/serviceStatus'
import {
  kindLabel, hasQuoteHistory, deactivateClient, reactivateClient, deleteClientPhysically,
  getFavoriteClientIds, setClientFavorite,
  fetchAddresses, createAddress, updateAddress, setPrimaryAddress, deleteAddress,
  fetchContacts, createContact, updateContact, setPrimaryContact, deleteContact,
} from '@/lib/clientDetails'

const BLANK_ADDRESS = { label: '', address: '', isPrimary: false }
const BLANK_CONTACT = { name: '', role: '', phone: '', email: '', isPrimary: false }

export default function ClienteDetallePage() {
  const { id } = useParams()
  const router = useRouter()
  const [userId, setUserId] = useState(null)
  const [isFavorite, setIsFavorite] = useState(false)
  const [client, setClient] = useState(null)
  const [config, setConfig] = useState(null)
  const [quotes, setQuotes] = useState([]) // solo las de tipo 'cotizacion' de este cliente
  const [receiptsByFolio, setReceiptsByFolio] = useState({})
  const [servicesByQuote, setServicesByQuote] = useState({})
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(null)
  const [tagsDraft, setTagsDraft] = useState('')

  const [addresses, setAddresses] = useState([])
  const [contacts, setContacts] = useState([])
  const [newAddress, setNewAddress] = useState(BLANK_ADDRESS)
  const [newContact, setNewContact] = useState(BLANK_CONTACT)

  async function loadAddresses() { setAddresses(await fetchAddresses(id)) }
  async function loadContacts() { setContacts(await fetchContacts(id)) }

  async function load() {
    const [{ data: c }, { data: cfg }] = await Promise.all([
      supabase.from('clients').select('*').eq('id', id).single(),
      supabase.from('app_config').select('*').eq('id', 1).single(),
    ])
    setClient(c)
    setConfig(cfg)
    if (c) {
      setForm({
        name: c.name || '', kind: c.kind || '',
        razon_social: c.razon_social || '', nombre_comercial: c.nombre_comercial || '',
        rfc: c.rfc || '', regimen_fiscal: c.regimen_fiscal || '', cp_fiscal: c.cp_fiscal || '',
        notes: c.notes || '',
      })
      setTagsDraft((c.tags || []).join(', '))
    }
    if (!c) return

    await Promise.all([loadAddresses(), loadContacts()])

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

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const uid = data.session?.user?.id || null
      setUserId(uid)
      if (uid) getFavoriteClientIds(uid).then((ids) => setIsFavorite(ids.has(id)))
    })
  }, [id])

  if (!client || !config || !form) return <div>Cargando…</div>

  async function toggleFavorite() {
    if (!userId) return
    const next = !isFavorite
    setIsFavorite(next)
    await setClientFavorite(userId, id, next)
  }

  async function saveClient() {
    await supabase.from('clients').update({
      name: form.name,
      kind: form.kind || null,
      razon_social: form.razon_social || null,
      nombre_comercial: form.nombre_comercial || null,
      rfc: form.rfc || null,
      regimen_fiscal: form.regimen_fiscal || null,
      cp_fiscal: form.cp_fiscal || null,
      notes: form.notes || null,
      updated_at: new Date().toISOString(),
    }).eq('id', id)
    setEditing(false)
    load()
  }

  async function saveTags() {
    const tags = tagsDraft.split(',').map((t) => t.trim()).filter(Boolean)
    await supabase.from('clients').update({ tags, updated_at: new Date().toISOString() }).eq('id', id)
    load()
  }

  async function handleRemove() {
    const withHistory = await hasQuoteHistory(id)
    if (withHistory) {
      const ok = window.confirm(
        `${client.name || 'Este cliente'} tiene cotizaciones registradas, así que no se puede eliminar.\n\n¿Deseas desactivarlo en su lugar? Podrás reactivarlo cuando quieras y su historial no se ve afectado.`
      )
      if (!ok) return
      await deactivateClient(id)
      load()
    } else {
      const ok = window.confirm(`¿Seguro que deseas eliminar a ${client.name || 'este cliente'}?\n\nNo tiene cotizaciones registradas, así que se borrará permanentemente y no podrás recuperarlo.`)
      if (!ok) return
      await deleteClientPhysically(id)
      router.push('/clientes')
    }
  }
  async function handleReactivate() {
    await reactivateClient(id)
    load()
  }

  // ---------- Direcciones ----------
  function updateAddressField(addrId, field, value) {
    setAddresses((prev) => prev.map((a) => (a.id === addrId ? { ...a, [field]: value } : a)))
  }
  async function saveAddressRow(a) {
    const { error } = await updateAddress(a.id, { address: a.address, label: a.label })
    if (error) { alert('No se pudo guardar la dirección: ' + error.message); loadAddresses(); return }
    if (a.is_primary) load()
  }
  async function makePrimaryAddress(a) {
    const { error } = await setPrimaryAddress(id, a.id)
    if (error) { alert('No se pudo marcar como principal: ' + error.message); return }
    await loadAddresses(); await load()
  }
  async function removeAddress(a) {
    const ok = window.confirm('¿Eliminar esta dirección?' + (a.is_primary ? '\n\nEs la dirección principal: al eliminarla, el cliente se queda sin dirección principal hasta que elijas otra.' : ''))
    if (!ok) return
    const { error } = await deleteAddress(a.id)
    if (error) { alert('No se pudo eliminar: ' + error.message); return }
    await loadAddresses(); await load()
  }
  async function addAddress() {
    if (!newAddress.address.trim()) { alert('Escribe la dirección.'); return }
    const { error } = await createAddress(id, newAddress)
    if (error) { alert('No se pudo agregar: ' + error.message); return }
    setNewAddress(BLANK_ADDRESS)
    await loadAddresses(); await load()
  }

  // ---------- Contactos ----------
  function updateContactField(contactId, field, value) {
    setContacts((prev) => prev.map((c) => (c.id === contactId ? { ...c, [field]: value } : c)))
  }
  async function saveContactRow(c) {
    const { error } = await updateContact(c.id, { name: c.name, role: c.role, phone: c.phone, email: c.email })
    if (error) { alert('No se pudo guardar el contacto: ' + error.message); loadContacts(); return }
    if (c.is_primary) load()
  }
  async function makePrimaryContact(c) {
    const { error } = await setPrimaryContact(id, c.id)
    if (error) { alert('No se pudo marcar como principal: ' + error.message); return }
    await loadContacts(); await load()
  }
  async function removeContact(c) {
    const ok = window.confirm('¿Eliminar este contacto?' + (c.is_primary ? '\n\nEs el contacto principal: al eliminarlo, el cliente se queda sin contacto principal (teléfono/correo) hasta que elijas otro.' : ''))
    if (!ok) return
    const { error } = await deleteContact(c.id)
    if (error) { alert('No se pudo eliminar: ' + error.message); return }
    await loadContacts(); await load()
  }
  async function addContact() {
    if (!newContact.name.trim()) { alert('Escribe el nombre del contacto.'); return }
    const { error } = await createContact(id, newContact)
    if (error) { alert('No se pudo agregar: ' + error.message); return }
    setNewContact(BLANK_CONTACT)
    await loadContacts(); await load()
  }

  // Fase 6.5 — mismas reglas de descarga que Historial (lib/pdf.js
  // centraliza la decisión persistido-vs-regenerado para que un mismo PDF
  // nunca se comporte distinto según desde qué pantalla se descargue).
  async function downloadPdf(rec) {
    const result = await resolveQuoteDownload(rec, config)
    if (!result.ok) { alert(result.message); return }
    triggerPdfDownload(result.blob, result.filename)
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button" className={`star-btn ${isFavorite ? 'is-fav' : ''}`}
          title={isFavorite ? 'Quitar de favoritos' : 'Marcar como favorito'}
          onClick={toggleFavorite} disabled={!userId}
        >★</button>
        <h2 className="pagetitle" style={{ margin: 0 }}>{client.name}</h2>
        <span className="badge neutral">{kindLabel(client.kind)}</span>
        <span className={`badge ${client.active ? 'rec' : 'can'}`}>{client.active ? 'ACTIVO' : 'INACTIVO'}</span>
      </div>
      <div className="pagesub">Cliente desde {new Date(client.created_at).toLocaleDateString('es-MX')}</div>

      <div className="grid2">
        <div>
          <div className="panel">
            <h3>Datos del cliente</h3>
            {editing ? (
              <>
                <div className="fieldrow">
                  <div className="field"><label>Nombre</label><input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
                  <div className="field">
                    <label>Tipo</label>
                    <select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
                      <option value="">Sin clasificar</option>
                      <option value="persona">Persona</option>
                      <option value="empresa">Empresa</option>
                    </select>
                  </div>
                </div>
                <div className="cat-detail-grid">
                  <div className="field" style={{ marginBottom: 0 }}><label>Razón social</label><input value={form.razon_social} onChange={(e) => setForm((f) => ({ ...f, razon_social: e.target.value }))} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label>Nombre comercial</label><input value={form.nombre_comercial} onChange={(e) => setForm((f) => ({ ...f, nombre_comercial: e.target.value }))} /></div>
                  <div className="field" style={{ marginBottom: 0 }}><label>RFC</label><input value={form.rfc} onChange={(e) => setForm((f) => ({ ...f, rfc: e.target.value }))} /></div>
                </div>
                <div className="fieldrow">
                  <div className="field"><label>Régimen fiscal</label><input value={form.regimen_fiscal} onChange={(e) => setForm((f) => ({ ...f, regimen_fiscal: e.target.value }))} /></div>
                  <div className="field"><label>CP fiscal</label><input value={form.cp_fiscal} onChange={(e) => setForm((f) => ({ ...f, cp_fiscal: e.target.value }))} /></div>
                </div>
                <div className="field">
                  <label>Notas internas</label>
                  <textarea rows={3} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
                </div>
                <div className="actionsbar" style={{ marginTop: 0 }}>
                  <button className="btn teal small" onClick={saveClient}>Guardar</button>
                  <button className="btn ghost small" onClick={() => setEditing(false)}>Cancelar</button>
                </div>
                <div className="helptext" style={{ marginTop: 10, marginBottom: 0 }}>
                  Los datos fiscales no se borran al cambiar el tipo — puedes ir y venir entre Persona y Empresa sin perder lo que ya capturaste.
                </div>
              </>
            ) : (
              <>
                <div className="muted">Teléfono: {client.phone || '—'}</div>
                <div className="muted">Correo: {client.email || '—'}</div>
                <div className="muted">Dirección: {client.address || '—'}</div>
                {(client.razon_social || client.nombre_comercial || client.rfc) && (
                  <>
                    <div className="muted">Razón social: {client.razon_social || '—'}</div>
                    <div className="muted">Nombre comercial: {client.nombre_comercial || '—'}</div>
                    <div className="muted">RFC: {client.rfc || '—'} {client.regimen_fiscal ? `· Régimen: ${client.regimen_fiscal}` : ''} {client.cp_fiscal ? `· CP: ${client.cp_fiscal}` : ''}</div>
                  </>
                )}
                {client.notes && <div className="muted">Notas: {client.notes}</div>}
                <div className="actionsbar">
                  <button className="btn ghost small" onClick={() => setEditing(true)}>Editar cliente</button>
                  <button className="btn teal small" onClick={() => router.push(`/cotizar?client=${id}`)}>+ Nueva cotización</button>
                  {client.active ? (
                    <button className="btn ghost small" onClick={handleRemove}>Eliminar / desactivar</button>
                  ) : (
                    <button className="btn ghost small" onClick={handleReactivate}>Reactivar</button>
                  )}
                </div>
                <div className="helptext" style={{ marginTop: 10, marginBottom: 0 }}>
                  Editar aquí no cambia las cotizaciones ya generadas — cada una conserva su propia copia de estos datos tal como
                  estaban en ese momento. Teléfono, correo y dirección se editan desde Direcciones y Contactos abajo, no aquí.
                </div>
              </>
            )}
            <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
              <label>Tags (separados por coma)</label>
              <input value={tagsDraft} onChange={(e) => setTagsDraft(e.target.value)} onBlur={saveTags} placeholder="Ej. VIP, cobranza lenta, referido" />
            </div>
          </div>

          <div className="panel">
            <h3>Direcciones</h3>
            {!addresses.length ? (
              <div className="muted" style={{ padding: 10 }}>Sin direcciones registradas.</div>
            ) : (
              addresses.map((a) => (
                <div className="cat-specs-row" key={a.id} style={{ gridTemplateColumns: '.7fr 1.6fr auto auto' }}>
                  <input value={a.label || ''} placeholder="Etiqueta (ej. Oficina)" onChange={(e) => updateAddressField(a.id, 'label', e.target.value)} onBlur={() => saveAddressRow(a)} />
                  <input value={a.address || ''} placeholder="Dirección" onChange={(e) => updateAddressField(a.id, 'address', e.target.value)} onBlur={() => saveAddressRow(a)} />
                  {a.is_primary ? (
                    <span className="badge rec">PRINCIPAL</span>
                  ) : (
                    <button type="button" className="btn ghost small" onClick={() => makePrimaryAddress(a)}>Hacer principal</button>
                  )}
                  <button type="button" className="iconbtn" title="Eliminar dirección" onClick={() => removeAddress(a)}>✕</button>
                </div>
              ))
            )}
            <div className="cat-specs-row" style={{ gridTemplateColumns: '.7fr 1.6fr auto auto', marginTop: 10 }}>
              <input value={newAddress.label} placeholder="Etiqueta" onChange={(e) => setNewAddress((f) => ({ ...f, label: e.target.value }))} />
              <input value={newAddress.address} placeholder="Nueva dirección" onChange={(e) => setNewAddress((f) => ({ ...f, address: e.target.value }))} />
              <label className="cat-active-toggle" style={{ marginBottom: 0 }}>
                <input type="checkbox" checked={newAddress.isPrimary} onChange={(e) => setNewAddress((f) => ({ ...f, isPrimary: e.target.checked }))} /> Principal
              </label>
              <button type="button" className="btn ghost small" onClick={addAddress}>+ Agregar</button>
            </div>
          </div>

          <div className="panel">
            <h3>Contactos</h3>
            {!contacts.length ? (
              <div className="muted" style={{ padding: 10 }}>Sin contactos registrados.</div>
            ) : (
              contacts.map((c) => (
                <div key={c.id} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid #EEF0F1' }}>
                  <div className="cat-detail-grid" style={{ marginBottom: 6 }}>
                    <input value={c.name || ''} placeholder="Nombre" onChange={(e) => updateContactField(c.id, 'name', e.target.value)} onBlur={() => saveContactRow(c)} />
                    <input value={c.role || ''} placeholder="Puesto (opcional)" onChange={(e) => updateContactField(c.id, 'role', e.target.value)} onBlur={() => saveContactRow(c)} />
                    {c.is_primary ? (
                      <span className="badge rec" style={{ justifySelf: 'start' }}>PRINCIPAL</span>
                    ) : (
                      <button type="button" className="btn ghost small" onClick={() => makePrimaryContact(c)}>Hacer principal</button>
                    )}
                  </div>
                  <div className="cat-specs-row" style={{ gridTemplateColumns: '1fr 1fr auto' }}>
                    <input value={c.phone || ''} placeholder="Teléfono" onChange={(e) => updateContactField(c.id, 'phone', e.target.value)} onBlur={() => saveContactRow(c)} />
                    <input value={c.email || ''} placeholder="Correo" onChange={(e) => updateContactField(c.id, 'email', e.target.value)} onBlur={() => saveContactRow(c)} />
                    <button type="button" className="iconbtn" title="Eliminar contacto" onClick={() => removeContact(c)}>✕</button>
                  </div>
                </div>
              ))
            )}
            <div className="cat-detail-grid" style={{ marginBottom: 6 }}>
              <input value={newContact.name} placeholder="Nombre del nuevo contacto" onChange={(e) => setNewContact((f) => ({ ...f, name: e.target.value }))} />
              <input value={newContact.role} placeholder="Puesto (opcional)" onChange={(e) => setNewContact((f) => ({ ...f, role: e.target.value }))} />
              <label className="cat-active-toggle" style={{ marginBottom: 0 }}>
                <input type="checkbox" checked={newContact.isPrimary} onChange={(e) => setNewContact((f) => ({ ...f, isPrimary: e.target.checked }))} /> Principal
              </label>
            </div>
            <div className="cat-specs-row" style={{ gridTemplateColumns: '1fr 1fr auto' }}>
              <input value={newContact.phone} placeholder="Teléfono" onChange={(e) => setNewContact((f) => ({ ...f, phone: e.target.value }))} />
              <input value={newContact.email} placeholder="Correo" onChange={(e) => setNewContact((f) => ({ ...f, email: e.target.value }))} />
              <button type="button" className="btn ghost small" onClick={addContact}>+ Agregar</button>
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
