// app/cotizar/page.js
'use client'
import { useEffect, useMemo, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { fmt, calcTotals, validateQuote } from '@/lib/calc'
import { nextFolio } from '@/lib/folio'
import { triggerPdfDownload } from '@/lib/pdf'
import { findOrCreateClient, searchClients } from '@/lib/clients'
import { fetchAddresses, fetchContacts } from '@/lib/clientDetails'
import {
  fetchCatalogItems, searchInItems, distinctCategories, getFavoriteIds, setFavorite,
  fetchUsageCounts, usageCountFor, sortByUsage,
} from '@/lib/catalog'
import {
  computeRequiresServiceSuggestion, catalogItemToLine, manualLine,
  withRecalculatedSubtotal, normalizeItem, buildClientSnapshot, buildCompanySnapshot,
} from '@/lib/quoteSnapshot'
import { publishQuoteRevision } from '@/lib/quotePublication'
import { canEditQuote } from '@/lib/quoteLifecycle'

const QUOTE_TYPES = [
  { value: 'instalacion', label: '🔧 Instalación' },
  { value: 'servicio', label: '🛠️ Servicio' },
  { value: 'venta', label: '📦 Venta de productos' },
]

// Campos opcionales que, si quedan vacíos, generan una advertencia (no un
// bloqueo) antes de guardar. Compartido por ambos formularios: solo lee
// draft.client/draft.notes, que existen en las dos formas de draft.
const OPTIONAL_FIELDS = [
  { get: (d) => d.client.phone, label: 'Teléfono del cliente' },
  { get: (d) => d.client.email, label: 'Correo del cliente' },
  { get: (d) => d.client.address, label: 'Dirección' },
  { get: (d) => d.notes, label: 'Notas para el cliente' },
]
function missingOptionalFields(draft) {
  return OPTIONAL_FIELDS.filter((f) => !String(f.get(draft) || '').trim()).map((f) => f.label)
}

// ============================================================================
// Fase 6.6B — LegacyContractedEditForm fue retirado por completo. Era el
// único camino que escribía directamente sobre una cotización ya contratada
// y sobre su recibo (UPDATE directo en ambos) — exactamente lo que Fase 6.6
// prohíbe: después de contratar, la cotización y su recibo quedan
// congelados; la única forma de "deshacer" es Cancelar Contratación
// (cancel_quote_contract, ver app/historial/page.js), nunca editar. Ver
// CotizarInner más abajo: una cotización que ya no está en
// lifecycle_status='cotizacion' ya no se enruta a ningún formulario de
// edición — solo se muestra un aviso.
// ============================================================================

// ============================================================================
// Formulario nuevo de Fase 5 — cotizaciones nuevas y ediciones de
// cotizaciones NO contratadas (legacy o ya creadas con este modelo).
// ============================================================================
function newDraft(config) {
  return {
    quoteType: '',
    client: { name: '', phone: '', email: '', address: '' },
    items: [],
    discountType: 'percent',
    discountValue: 0,
    notes: '',
    validDays: config?.valid_days || 15,
    installTimeValue: '',
    installTimeUnit: 'horas',
    requiresServiceOverridden: false,
    requiresServiceManual: false, // solo tiene sentido cuando requiresServiceOverridden === true
  }
}

// ============================================================================
// Fase 6.7C-1 — la publicación de una cotización (campos + published_snapshot
// + content_revision + PDF inmutable por revisión) vive en
// lib/quotePublication.js. Se retiraron de aquí el flujo de logo en dos
// pasos (temporal + promoción a quotes/{id}/logo) y persistQuotePdfAndGetBlob
// (PDF en la ruta canónica quote.pdf con upsert): ambos reemplazaban archivos
// existentes, exactamente lo que una revisión inmutable no puede hacer.
// ============================================================================

function NewQuoteForm({ editingRec, config, clientIdParam, router }) {
  const [draft, setDraft] = useState(null)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  // Fase 6.7C-1 — fila real sobre la que se publica: la que se abrió a editar,
  // o la recién creada (para reintentar la publicación sin duplicar). Su
  // content_revision es la revisión BASE del CAS.
  const [baseRow, setBaseRow] = useState(editingRec || null)
  const [previewFolio, setPreviewFolio] = useState('')
  const [justAddedIdx, setJustAddedIdx] = useState(null)

  // ---------- Cliente ----------
  const [clientMode, setClientMode] = useState(clientIdParam ? 'existente' : 'nuevo')
  const [selectedClientId, setSelectedClientId] = useState(null)
  const [selectedClientRow, setSelectedClientRow] = useState(null) // fila completa de `clients`, para el snapshot
  const [clientSuggestions, setClientSuggestions] = useState([])
  const [clientAddresses, setClientAddresses] = useState([])
  const [clientContacts, setClientContacts] = useState([])
  const [selectedAddressId, setSelectedAddressId] = useState(null)
  const [selectedContactId, setSelectedContactId] = useState(null)

  // ---------- Dirección de servicio ----------
  const [serviceAddressOrigin, setServiceAddressOrigin] = useState('selected_client_address')
  const [serviceOtherAddressId, setServiceOtherAddressId] = useState(null)
  const [serviceManualAddress, setServiceManualAddress] = useState('')

  // ---------- Catálogo (reutiliza lib/catalog.js de Fase 3) ----------
  const [userId, setUserId] = useState(null)
  const [catalogItems, setCatalogItems] = useState([])
  const [favoriteIds, setFavoriteIds] = useState(new Set())
  const [usage, setUsage] = useState({ byId: new Map(), byName: new Map() })
  const [searchText, setSearchText] = useState('')
  const [debouncedText, setDebouncedText] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [onlyFavorites, setOnlyFavorites] = useState(false)
  const [sortMostUsed, setSortMostUsed] = useState(false)
  const [catalogStaged, setCatalogStaged] = useState({}) // { [itemId]: { qty, price } }

  // ---------- Carga inicial ----------
  useEffect(() => {
    let active = true
    async function selectExistingClient(client, preferredAddressId, preferredContactId) {
      setSelectedClientId(client.id)
      setSelectedClientRow(client)
      const [addrs, contacts] = await Promise.all([fetchAddresses(client.id), fetchContacts(client.id)])
      if (!active) return { addr: null, contact: null }
      setClientAddresses(addrs)
      setClientContacts(contacts)
      const addr = (preferredAddressId && addrs.find((a) => a.id === preferredAddressId)) || addrs.find((a) => a.is_primary) || addrs[0] || null
      const contact = (preferredContactId && contacts.find((c) => c.id === preferredContactId)) || contacts.find((c) => c.is_primary) || contacts[0] || null
      setSelectedAddressId(addr ? addr.id : null)
      setSelectedContactId(contact ? contact.id : null)
      return { addr, contact }
    }

    async function load() {
      if (editingRec) {
        const normalizedItems = (editingRec.items || []).map(normalizeItem)
        setDraft({
          quoteType: editingRec.quote_type || '',
          client: { name: editingRec.client_name || '', phone: editingRec.client_phone || '', email: editingRec.client_email || '', address: editingRec.client_address || '' },
          items: normalizedItems,
          discountType: editingRec.discount_type,
          discountValue: editingRec.discount_value,
          notes: editingRec.notes || '',
          validDays: editingRec.valid_days,
          installTimeValue: editingRec.install_time_value ?? '',
          installTimeUnit: editingRec.install_time_unit || 'horas',
          requiresServiceOverridden: true, // respeta el valor guardado; no se recalcula solo por abrir a editar
          requiresServiceManual: editingRec.requires_service ?? computeRequiresServiceSuggestion(editingRec.quote_type, normalizedItems),
        })
        if (editingRec.client_id) {
          const { data: c } = await supabase.from('clients').select('*').eq('id', editingRec.client_id).single()
          if (active && c) {
            setClientMode('existente')
            await selectExistingClient(
              c,
              editingRec.client_snapshot?.selected_address?.id ?? null,
              editingRec.client_snapshot?.selected_contact?.id ?? null,
            )
            // OJO: draft.client.* ya viene de las columnas planas del registro
            // (arriba) y NO se sobreescribe aquí — es lo que realmente se
            // guardó; los selects de dirección/contacto solo sirven para que,
            // si el usuario los cambia, el nuevo snapshot lo refleje.
          }
        }
        return
      }

      if (clientIdParam) {
        const { data: client } = await supabase.from('clients').select('*').eq('id', clientIdParam).single()
        if (client && active) {
          const { addr, contact } = await selectExistingClient(client, null, null)
          setDraft({
            ...newDraft(config),
            client: {
              name: client.name || '',
              phone: contact?.phone || client.phone || '',
              email: contact?.email || client.email || '',
              address: addr?.address || client.address || '',
            },
          })
          setPreviewFolio(await nextFolio('cotizacion'))
          return
        }
      }

      setDraft(newDraft(config))
      setPreviewFolio(await nextFolio('cotizacion'))
    }
    load()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (justAddedIdx === null) return
    const t = setTimeout(() => setJustAddedIdx(null), 1200)
    return () => clearTimeout(t)
  }, [justAddedIdx])

  // ---------- Catálogo: carga y filtros ----------
  useEffect(() => {
    fetchCatalogItems({ type: filterType || undefined, category: filterCategory || undefined, status: 'active' })
      .then(({ data }) => setCatalogItems(data))
  }, [filterType, filterCategory])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const uid = data.session?.user?.id || null
      setUserId(uid)
      if (uid) getFavoriteIds(uid).then(setFavoriteIds)
    })
    fetchUsageCounts().then(setUsage)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedText(searchText), 300)
    return () => clearTimeout(t)
  }, [searchText])

  const displayCatalog = useMemo(() => {
    let list = searchInItems(catalogItems, debouncedText)
    if (onlyFavorites) list = list.filter((it) => favoriteIds.has(it.id))
    if (sortMostUsed) list = sortByUsage(list, usage)
    return list
  }, [catalogItems, debouncedText, onlyFavorites, favoriteIds, sortMostUsed, usage])

  const categories = useMemo(() => distinctCategories(catalogItems), [catalogItems])

  if (!draft || !config) return <div>Cargando…</div>

  // requires_service se deriva en cada render — nunca se sincroniza vía
  // efecto: mientras no haya override, siempre refleja la sugerencia actual;
  // en cuanto el usuario lo toca a mano, queda congelado en requiresServiceManual.
  const requiresService = draft.requiresServiceOverridden
    ? draft.requiresServiceManual
    : computeRequiresServiceSuggestion(draft.quoteType, draft.items)

  const totals = calcTotals(draft.items, draft.discountType, draft.discountValue, config.apply_iva, config.iva_rate)
  const displayFolio = editingRec ? editingRec.folio : (previewFolio || '…')

  // ---------- Cliente ----------
  function updateClient(field, value) {
    if (field === 'name') setSelectedClientId(null)
    setDraft((d) => ({ ...d, client: { ...d.client, [field]: value } }))
  }
  async function searchClientSuggestions(text) {
    if (clientMode === 'nuevo') { setClientSuggestions([]); return }
    setClientSuggestions(await searchClients(text))
  }
  async function applyClientSuggestion(c) {
    setClientSuggestions([])
    setSelectedClientId(c.id)
    setSelectedClientRow(c)
    const [addrs, contacts] = await Promise.all([fetchAddresses(c.id), fetchContacts(c.id)])
    setClientAddresses(addrs)
    setClientContacts(contacts)
    const addr = addrs.find((a) => a.is_primary) || addrs[0] || null
    const contact = contacts.find((x) => x.is_primary) || contacts[0] || null
    setSelectedAddressId(addr ? addr.id : null)
    setSelectedContactId(contact ? contact.id : null)
    setDraft((d) => ({
      ...d,
      client: {
        name: c.name || '',
        phone: contact?.phone || c.phone || '',
        email: contact?.email || c.email || '',
        address: addr?.address || c.address || '',
      },
    }))
  }
  function switchClientMode(mode) {
    setClientMode(mode)
    setSelectedClientId(null)
    setSelectedClientRow(null)
    setClientAddresses([])
    setClientContacts([])
    setSelectedAddressId(null)
    setSelectedContactId(null)
    setClientSuggestions([])
    if (mode === 'nuevo') setDraft((d) => ({ ...d, client: { name: '', phone: '', email: '', address: '' } }))
  }
  function handleAddressChange(addressId) {
    setSelectedAddressId(addressId)
    const addr = clientAddresses.find((a) => a.id === addressId)
    if (addr) setDraft((d) => ({ ...d, client: { ...d.client, address: addr.address } }))
  }
  function handleContactChange(contactId) {
    setSelectedContactId(contactId)
    const c = clientContacts.find((x) => x.id === contactId)
    if (c) setDraft((d) => ({ ...d, client: { ...d.client, phone: c.phone || '', email: c.email || '' } }))
  }

  // ---------- Catálogo / items ----------
  async function toggleCatalogFavorite(item) {
    if (!userId) return
    const isFav = favoriteIds.has(item.id)
    setFavoriteIds((prev) => {
      const next = new Set(prev)
      if (isFav) next.delete(item.id); else next.add(item.id)
      return next
    })
    await setFavorite(userId, item.id, !isFav)
  }
  function updateStaged(itemId, field, value) {
    setCatalogStaged((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), [field]: value } }))
  }
  function addFromCatalog(item) {
    const staged = catalogStaged[item.id] || {}
    const qty = staged.qty === '' || staged.qty == null ? 1 : staged.qty
    const price = staged.price === '' || staged.price == null ? item.price : staged.price
    const line = catalogItemToLine(item, qty, price)
    setDraft((d) => {
      const items = [...d.items, line]
      setJustAddedIdx(items.length - 1)
      return { ...d, items }
    })
  }
  function addBlankItem() {
    setDraft((d) => {
      const items = [...d.items, manualLine()]
      setJustAddedIdx(items.length - 1)
      return { ...d, items }
    })
  }
  function updateItem(idx, field, value) {
    setDraft((d) => {
      const items = d.items.slice()
      items[idx] = withRecalculatedSubtotal({ ...items[idx], [field]: value })
      return { ...d, items }
    })
  }
  function removeItem(idx) {
    setDraft((d) => ({ ...d, items: d.items.filter((_, i) => i !== idx) }))
  }

  // ---------- requires_service ----------
  function toggleRequiresService(checked) {
    setDraft((d) => ({ ...d, requiresServiceOverridden: true, requiresServiceManual: checked }))
  }
  function useAutomaticSuggestion() {
    setDraft((d) => ({ ...d, requiresServiceOverridden: false }))
  }

  // ---------- Dirección de servicio ----------
  function resolveServiceAddress() {
    if (serviceAddressOrigin === 'manual') {
      return { origin: 'manual', addressId: null, address: serviceManualAddress }
    }
    if (serviceAddressOrigin === 'other_client_address') {
      const addr = clientAddresses.find((a) => a.id === serviceOtherAddressId)
      return { origin: 'other_client_address', addressId: addr ? addr.id : null, address: addr ? addr.address : '' }
    }
    const addr = clientAddresses.find((a) => a.id === selectedAddressId)
    return { origin: 'selected_client_address', addressId: addr ? addr.id : null, address: addr ? addr.address : draft.client.address }
  }

  async function handleSubmit() {
    const { errors: errs, hasErrors } = validateQuote(draft)
    if (!editingRec && !draft.quoteType) errs.quoteType = 'Elige el tipo de cotización.'
    if (requiresService) {
      const resolved = resolveServiceAddress()
      if (!resolved.address || !resolved.address.trim()) errs.serviceAddress = 'Indica la dirección donde se realizará el servicio.'
    }
    const blocked = hasErrors || !!errs.quoteType || !!errs.serviceAddress
    setErrors(errs)
    if (blocked) return

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
    const clientId = selectedClientId || await findOrCreateClient(draft.client)
    const items = draft.items.map(withRecalculatedSubtotal)
    const t = calcTotals(items, draft.discountType, draft.discountValue, config.apply_iva, config.iva_rate)
    const serviceAddress = requiresService ? resolveServiceAddress() : null
    // Única fuente para el quote_type que se guarda y el que resuelve el
    // snapshot de empresa — nunca deben poder divergir.
    const effectiveQuoteType = draft.quoteType || null

    const clientSnapshot = buildClientSnapshot({
      client: selectedClientRow,
      draftClient: draft.client,
      selectedAddress: clientAddresses.find((a) => a.id === selectedAddressId) || null,
      selectedContact: clientContacts.find((c) => c.id === selectedContactId) || null,
      serviceAddress,
    })
    const companySnapshot = buildCompanySnapshot(config, effectiveQuoteType)

    const payload = {
      client_id: clientId,
      client_name: draft.client.name,
      client_phone: draft.client.phone,
      client_email: draft.client.email,
      client_address: draft.client.address,
      items,
      discount_type: draft.discountType,
      discount_value: draft.discountValue,
      notes: draft.notes,
      valid_days: draft.validDays,
      install_time_value: draft.installTimeValue === '' ? null : draft.installTimeValue,
      install_time_unit: draft.installTimeValue === '' ? null : draft.installTimeUnit,
      subtotal: t.subtotal,
      discount: t.discount,
      iva: t.iva,
      iva_rate: config.iva_rate,
      apply_iva: config.apply_iva,
      total: t.total,
      quote_type: effectiveQuoteType,
      requires_service: requiresService,
      service_address: serviceAddress ? serviceAddress.address : null,
      client_snapshot: clientSnapshot,
      company_snapshot: companySnapshot,
    }

    // Fase 6.7C-1 — creación y publicación son operaciones SEPARADAS.
    // 1) Creación: el INSERT precontractual sigue obteniendo id, created_at,
    //    folio y valid_until reales de PostgreSQL. Si la publicación de abajo
    //    falla, esta fila permanece NO publicada (content_revision,
    //    published_snapshot y pdf_storage_path en NULL) y NO se borra; baseRow
    //    la recuerda para que el siguiente intento publique SIN crear otra.
    // 2) Publicación: lib/quotePublication.js sube una revisión inmutable y
    //    publica campos + snapshot + revision + path con un único CAS. En una
    //    EDICIÓN no se escribe nada en la DB antes de que Storage confirme.
    let row = baseRow
    if (!row) {
      const folio = await nextFolio('cotizacion')
      // lifecycle_status es obligatorio para status='cotizacion' desde el CHECK
      // constraint de Fase 2 (quotes_status_lifecycle_check) — el INSERT falla
      // sin él.
      const { data, error } = await supabase.from('quotes').insert({ ...payload, folio, status: 'cotizacion', lifecycle_status: 'cotizacion' }).select().single()
      if (error) { alert('No se pudo guardar: ' + error.message); setSaving(false); return }
      row = data
      setBaseRow(row)
    }

    let result
    try {
      result = await publishQuoteRevision({ row, payload, config })
    } catch (e) {
      result = { ok: false, message: 'Error inesperado al publicar: ' + (e && e.message ? e.message : e) + '. Tus cambios siguen en el formulario.' }
    }

    if (!result.ok) {
      // Si la DB llegó a avanzar (verificación fallida) la base del siguiente
      // intento es la fila devuelta, no la que se cargó al abrir el formulario.
      if (result.row) setBaseRow(result.row)
      setSaving(false)
      alert(result.message + (!editingRec && row ? `\n\nLa cotización ${row.folio} ya fue creada pero NO está publicada; al guardar de nuevo se reintentará la publicación sin crear otra.` : ''))
      return
    }

    triggerPdfDownload(result.blob, result.row.folio + '.pdf')
    setSaving(false)
    if (result.warnings.length) alert(result.warnings.join('\n'))
    router.push('/historial')
  }

  const itemErr = (idx, field) => errors.itemErrors?.[idx]?.[field]

  return (
    <div>
      <h2 className="pagetitle">{editingRec ? 'Editar cotización' : 'Nueva cotización'}</h2>
      <div className="pagesub">Clasifica el tipo, elige o captura el cliente, agrega conceptos del catálogo o manuales, y genera el PDF.</div>

      {!editingRec && baseRow && !baseRow.content_revision && (
        <div className="editbanner">
          <span>La cotización <strong>{baseRow.folio}</strong> ya fue creada pero <strong>aún no está publicada</strong> (sin PDF vigente). Al guardar se reintenta la publicación sin crear otra.</span>
        </div>
      )}

      {editingRec && (
        <div className="editbanner">
          <span>Estás editando <strong>{editingRec.folio}</strong>. Al guardar se actualiza ese mismo registro.</span>
          <button className="btn ghost small" onClick={() => router.push('/historial')}>Cancelar edición</button>
        </div>
      )}

      <div className="grid2">
        <div>
          <div className="panel">
            <h3>Tipo de cotización</h3>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {QUOTE_TYPES.map((t) => (
                <button
                  key={t.value} type="button"
                  className={`btn small ${draft.quoteType === t.value ? 'teal' : 'ghost'}`}
                  onClick={() => setDraft((d) => ({ ...d, quoteType: t.value }))}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {errors.quoteType && <div className="fielderr">{errors.quoteType}</div>}
            {!draft.quoteType && editingRec && (
              <div className="helptext" style={{ marginTop: 8, marginBottom: 0 }}>Esta cotización es anterior a esta clasificación — puedes dejarla sin tipo o elegir uno ahora.</div>
            )}
          </div>

          <div className="panel">
            <h3>Datos del cliente</h3>
            {!editingRec && !clientIdParam && (
              <div className="field" style={{ display: 'flex', gap: 18, marginBottom: 14 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 0, cursor: 'pointer' }}>
                  <input type="radio" style={{ width: 'auto' }} checked={clientMode === 'nuevo'} onChange={() => switchClientMode('nuevo')} /> Nuevo cliente
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 0, cursor: 'pointer' }}>
                  <input type="radio" style={{ width: 'auto' }} checked={clientMode === 'existente'} onChange={() => switchClientMode('existente')} /> Cliente existente
                </label>
              </div>
            )}
            {clientIdParam && (
              <div className="helptext" style={{ marginBottom: 12 }}>
                Cliente existente — los datos se precargaron; puedes ajustarlos solo para esta cotización, sin afectar el registro maestro.
              </div>
            )}
            {clientMode === 'existente' && !selectedClientId && !clientIdParam && (
              <div className="helptext" style={{ marginBottom: 4 }}>Escribe el nombre para buscar entre tus clientes ya registrados.</div>
            )}
            <div className="fieldrow">
              <div className="field" style={{ position: 'relative' }}>
                <label>Nombre / empresa</label>
                <input
                  className={errors.name ? 'input-error' : ''}
                  value={draft.client.name}
                  onChange={(e) => { updateClient('name', e.target.value); searchClientSuggestions(e.target.value) }}
                  onBlur={() => setTimeout(() => setClientSuggestions([]), 150)}
                  autoComplete="off"
                />
                {errors.name && <div className="fielderr">{errors.name}</div>}
                {clientSuggestions.length > 0 && (
                  <div className="send-menu-popover" style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4 }}>
                    {clientSuggestions.map((c) => (
                      <button key={c.id} type="button" onClick={() => applyClientSuggestion(c)}>
                        {c.name} {c.phone ? `· ${c.phone}` : ''}
                      </button>
                    ))}
                  </div>
                )}
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
            {selectedClientId && (clientAddresses.length > 0 || clientContacts.length > 0) && (
              <div className="fieldrow" style={{ marginTop: 0 }}>
                {clientAddresses.length > 0 && (
                  <div className="field">
                    <label>Dirección del cliente</label>
                    <select value={selectedAddressId || ''} onChange={(e) => handleAddressChange(e.target.value)}>
                      {clientAddresses.map((a) => (
                        <option key={a.id} value={a.id}>{a.label ? `${a.label} — ` : ''}{a.address}{a.is_primary ? ' (principal)' : ''}</option>
                      ))}
                    </select>
                  </div>
                )}
                {clientContacts.length > 0 && (
                  <div className="field">
                    <label>Contacto del cliente</label>
                    <select value={selectedContactId || ''} onChange={(e) => handleContactChange(e.target.value)}>
                      {clientContacts.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}{c.role ? ` (${c.role})` : ''}{c.is_primary ? ' — principal' : ''}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="panel">
            <h3>Catálogo</h3>
            <div className="fieldrow" style={{ marginBottom: 10 }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Buscar (nombre, SKU, categoría, tags, ficha técnica)</label>
                <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Ej. Dahua, cableado, 4mp..." />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Tipo</label>
                <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
                  <option value="">Todos</option>
                  <option value="producto">Producto</option>
                  <option value="servicio">Servicio</option>
                </select>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Categoría</label>
                <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
                  <option value="">Todas</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 0, cursor: 'pointer' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={onlyFavorites} onChange={(e) => setOnlyFavorites(e.target.checked)} /> Solo favoritos
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 0, cursor: 'pointer' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={sortMostUsed} onChange={(e) => setSortMostUsed(e.target.checked)} /> Más usados primero
              </label>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8, marginBottom: 12 }}>
              {!displayCatalog.length ? (
                <div className="muted" style={{ padding: 14, textAlign: 'center' }}>No hay productos o servicios que coincidan.</div>
              ) : displayCatalog.map((item) => {
                const staged = catalogStaged[item.id] || {}
                return (
                  <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid #EEF0F1' }}>
                    <button
                      type="button" className={`star-btn ${favoriteIds.has(item.id) ? 'is-fav' : ''}`}
                      title={favoriteIds.has(item.id) ? 'Quitar de favoritos' : 'Marcar como favorito'}
                      onClick={() => toggleCatalogFavorite(item)} disabled={!userId}
                    >★</button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="cell-ell" title={item.name}>{item.name}</div>
                      {usageCountFor(item, usage) > 0 && <div className="muted" style={{ fontSize: 11 }}>Usado {usageCountFor(item, usage)}x</div>}
                    </div>
                    <input
                      type="number" min="0" step="0.01" style={{ width: 90 }}
                      value={staged.price ?? item.price}
                      onChange={(e) => updateStaged(item.id, 'price', e.target.value === '' ? '' : parseFloat(e.target.value))}
                    />
                    <input
                      type="number" min="1" step="1" style={{ width: 60 }}
                      value={staged.qty ?? 1}
                      onChange={(e) => updateStaged(item.id, 'qty', e.target.value === '' ? '' : parseInt(e.target.value))}
                    />
                    <button type="button" className="btn teal small" onClick={() => addFromCatalog(item)}>+ Agregar</button>
                  </div>
                )
              })}
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
                <div className="f-importe">{fmt(it.subtotal ?? ((it.price || 0) * (it.qty || 0)))}</div>
                <button className="iconbtn f-del" onClick={() => removeItem(idx)}>✕</button>
              </div>
            ))}
            <button className="btn ghost small" onClick={addBlankItem}>+ Agregar línea libre</button>
          </div>

          <div className="panel">
            <h3>Servicio</h3>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: draft.requiresServiceOverridden ? 6 : 0 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={requiresService} onChange={(e) => toggleRequiresService(e.target.checked)} />
              Requiere servicio o instalación posterior
            </label>
            {draft.requiresServiceOverridden && (
              <button type="button" className="btn ghost small" onClick={useAutomaticSuggestion} style={{ marginBottom: 12 }}>
                Usar recomendación automática
              </button>
            )}
            {requiresService && (
              <div style={{ marginTop: 10 }}>
                <label style={{ display: 'block', fontSize: 11.5, color: 'var(--steel)', marginBottom: 6, fontWeight: 600 }}>Dirección de servicio</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 0, cursor: 'pointer' }}>
                    <input type="radio" style={{ width: 'auto' }} checked={serviceAddressOrigin === 'selected_client_address'} onChange={() => setServiceAddressOrigin('selected_client_address')} />
                    Usar la dirección del cliente seleccionada arriba
                  </label>
                  {clientAddresses.length > 0 && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 0, cursor: 'pointer' }}>
                      <input type="radio" style={{ width: 'auto' }} checked={serviceAddressOrigin === 'other_client_address'} onChange={() => setServiceAddressOrigin('other_client_address')} />
                      Elegir otra dirección registrada del cliente
                    </label>
                  )}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 0, cursor: 'pointer' }}>
                    <input type="radio" style={{ width: 'auto' }} checked={serviceAddressOrigin === 'manual'} onChange={() => setServiceAddressOrigin('manual')} />
                    Dirección manual distinta
                  </label>
                </div>
                {serviceAddressOrigin === 'other_client_address' && (
                  <select value={serviceOtherAddressId || ''} onChange={(e) => setServiceOtherAddressId(e.target.value)} style={{ marginBottom: 6 }}>
                    <option value="">— elegir dirección —</option>
                    {clientAddresses.map((a) => (
                      <option key={a.id} value={a.id}>{a.label ? `${a.label} — ` : ''}{a.address}</option>
                    ))}
                  </select>
                )}
                {serviceAddressOrigin === 'manual' && (
                  <input value={serviceManualAddress} onChange={(e) => setServiceManualAddress(e.target.value)} placeholder="Dirección donde se realizará el servicio" />
                )}
                {errors.serviceAddress && <div className="fielderr">{errors.serviceAddress}</div>}
              </div>
            )}
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
            <div className="fieldrow">
              <div className="field" style={{ maxWidth: 200 }}>
                <label>Vigencia (días)</label>
                <input type="number" min="1" value={draft.validDays} onChange={(e) => setDraft((d) => ({ ...d, validDays: parseInt(e.target.value) || 1 }))} />
              </div>
              <div className="field">
                <label>Tiempo de instalación estimado (opcional)</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="number" min="0" step="0.5" style={{ flex: 1 }}
                    value={draft.installTimeValue}
                    onChange={(e) => setDraft((d) => ({ ...d, installTimeValue: e.target.value === '' ? '' : parseFloat(e.target.value) }))}
                  />
                  <select
                    style={{ flex: 1 }}
                    value={draft.installTimeUnit}
                    onChange={(e) => setDraft((d) => ({ ...d, installTimeUnit: e.target.value }))}
                  >
                    <option value="horas">Horas</option>
                    <option value="dias">Días</option>
                  </select>
                </div>
              </div>
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
                <div className="meta">
                  FOLIO {displayFolio} · VIGENCIA {draft.validDays} DÍAS
                  {draft.installTimeValue !== '' && draft.installTimeValue != null && (
                    <> · INSTALACIÓN EST. {draft.installTimeValue} {draft.installTimeUnit === 'dias' ? 'DÍAS' : 'HORAS'}</>
                  )}
                </div>
              </div>
            </div>
            <div className="ticket-body">
              {draft.items.length ? draft.items.map((it, idx) => (
                <div className="ticket-line" key={idx}>
                  <span>{it.name || '—'} <span className="muted">×{it.qty || 0}</span></span>
                  <span>{fmt(it.subtotal ?? ((it.price || 0) * (it.qty || 0)))}</span>
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

// ============================================================================
// Punto de entrada: decide, una sola vez por carga, cuál de los dos
// formularios de arriba renderizar.
// ============================================================================
function CotizarInner() {
  const router = useRouter()
  const params = useSearchParams()
  const editId = params.get('edit')
  const clientIdParam = params.get('client')

  const [config, setConfig] = useState(null)
  const [editingRec, setEditingRec] = useState(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let active = true
    async function load() {
      const { data: cfg } = await supabase.from('app_config').select('*').eq('id', 1).single()
      if (!active) return
      setConfig(cfg)
      if (editId) {
        const { data: rec } = await supabase.from('quotes').select('*').eq('id', editId).single()
        if (active) setEditingRec(rec || null)
      }
      if (active) setReady(true)
    }
    load()
    return () => { active = false }
  }, [editId])

  if (!ready || !config) return <div>Cargando…</div>

  // Fase 6.6B — después de contratar, la cotización (y su recibo) quedan
  // congelados; cancelar una contratación tampoco la vuelve editable. La
  // única cotización editable es la que sigue en lifecycle_status='cotizacion'.
  // Si editId apunta a una que ya no lo está, no se renderiza ningún
  // formulario — antes esto se resolvía con LegacyContractedEditForm
  // (retirado, ver arriba), que sí permitía escribir directamente sobre una
  // contratada y su recibo.
  if (editingRec && !canEditQuote(editingRec)) {
    return (
      <div>
        <h2 className="pagetitle">Cotización no editable</h2>
        <div className="pagesub">
          <strong>{editingRec.folio}</strong> ya no se puede editar: está {editingRec.lifecycle_status === 'cancelado' ? 'cancelada' : 'contratada'}.
          {editingRec.lifecycle_status === 'contratado' && ' Para revertir la contratación, usa "Cancelar contratación" desde Historial.'}
        </div>
        <button className="btn ghost" onClick={() => router.push('/historial')}>Volver a Historial</button>
      </div>
    )
  }
  return <NewQuoteForm editingRec={editingRec} config={config} clientIdParam={clientIdParam} router={router} />
}

export default function CotizarPage() {
  return (
    <Suspense fallback={<div>Cargando…</div>}>
      <CotizarInner />
    </Suspense>
  )
}
