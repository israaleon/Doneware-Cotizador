// app/cotizar/page.js
'use client'
import { useEffect, useMemo, useRef, useState, Suspense } from 'react'
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
  computeRequiresServiceSuggestion, manualLine,
  withRecalculatedSubtotal, normalizeItem, buildClientSnapshot, buildCompanySnapshot,
} from '@/lib/quoteSnapshot'
import { publishQuoteRevision } from '@/lib/quotePublication'
import { initialServiceAddress, resolveServiceAddress as resolveServiceAddressFor, serviceAddressAfterClientChange } from '@/lib/serviceAddress'
import { canEditQuote } from '@/lib/quoteLifecycle'
import { registerUnsavedGuard } from '@/lib/unsavedGuard'
import { parseQuoteTypeParam, QUOTE_TYPE_CARDS } from '@/lib/quoteTypes'
import { quoteTypeChangeEffects, quoteTypeLabel } from '@/lib/quoteTypeChange'
import { addCatalogProduct, duplicateCatalogProducts, summarizeText } from '@/lib/quoteLines'
import GuardedLink from '@/components/GuardedLink'
import DonnieIcon, { DonnieTrash } from '@/components/DonnieIcon'

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
function newDraft(config, initialType = '') {
  return {
    quoteType: initialType, // N3-A: la pantalla de selección abre el formulario con ?tipo=; sin él (o en ediciones) no cambia nada
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

function NewQuoteForm({ editingRec, config, clientIdParam, initialType, router }) {
  const [draft, setDraft] = useState(null)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  // Fase 6.7C-1 — fila real sobre la que se publica: la que se abrió a editar,
  // o la recién creada (para reintentar la publicación sin duplicar). Su
  // content_revision es la revisión BASE del CAS.
  const [baseRow, setBaseRow] = useState(editingRec || null)
  const [previewFolio, setPreviewFolio] = useState('')
  const [justAddedIdx, setJustAddedIdx] = useState(null)
  // N3-C — «Tipo de cotización: [tipo] · Cambiar»: el panel de opciones abre solo si la cotización nueva aún no tiene tipo; el cambio que descartaría información
  // espera confirmación en typePending (nada se aplica hasta confirmar; Cancelar deja el formulario como estaba).
  const [typePanelOpen, setTypePanelOpen] = useState(!editingRec && !initialType)
  const [typePending, setTypePending] = useState(null) // { to, losses, notes }
  const [typeNotice, setTypeNotice] = useState('')
  const confirmRef = useRef(null)

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
  // Al EDITAR, se inicializa desde la dirección ya guardada (lib/serviceAddress.js): sin eso, un guardado sin tocarla la sustituía por la del cliente.
  // Si la persona ya eligió algo, la carga asíncrona de las direcciones del cliente no lo pisa (serviceAddressTouchedRef).
  const serviceAddressTouchedRef = useRef(false)
  // Vigencia de las cargas de cliente: cada selección, limpieza o cambio de modo de cliente invalida las respuestas (direcciones y contactos) que aún no llegaron.
  const clientRequestRef = useRef(0)
  // N2 — aviso de cambios sin guardar (lib/unsavedGuard.js): borrador con el que quedó listo el formulario (lo fija la carga, no la persona) y el último estado visto.
  const baselineRef = useRef(null)
  const latestRef = useRef({ draft: null, staged: {} })
  const setLoadedDraft = (d) => { baselineRef.current = JSON.stringify(d); setDraft(d) }
  const [serviceAddressOrigin, setServiceAddressOriginRaw] = useState('selected_client_address')
  const [serviceOtherAddressId, setServiceOtherAddressIdRaw] = useState(null)
  const [serviceManualAddress, setServiceManualAddressRaw] = useState('')
  // Dirección pendiente de confirmación tras cambiar de cliente al editar: { kind: 'previous_client_address' | 'unknown_origin', text } (ver serviceAddressAfterClientChange).
  const [serviceAddressPending, setServiceAddressPending] = useState(null)
  // Hay una carga de cliente en curso: no se permite guardar hasta que termine, para que el resultado no dependa del momento en que llegan las direcciones.
  const [clientLoading, setClientLoading] = useState(false)
  const setServiceAddressOrigin = (v) => { serviceAddressTouchedRef.current = true; setServiceAddressPending(null); setServiceAddressOriginRaw(v) }
  const setServiceOtherAddressId = (v) => { serviceAddressTouchedRef.current = true; setServiceAddressPending(null); setServiceOtherAddressIdRaw(v) }
  const setServiceManualAddress = (v) => { serviceAddressTouchedRef.current = true; setServiceAddressPending(null); setServiceManualAddressRaw(v) }
  function applyInitialServiceAddress(init) {
    setServiceAddressOriginRaw(init.origin)
    setServiceOtherAddressIdRaw(init.otherAddressId)
    setServiceManualAddressRaw(init.manualAddress)
    setServiceAddressPending(init.pending || null)
  }
  // Al CAMBIAR de cliente al editar (elegir otro, limpiar la selección o cambiar el modo), la dirección de servicio sigue el origen persistido de la cotización;
  // no depende de lo que haya cargado. Si la persona ya eligió la dirección de servicio a mano, no se toca.
  function serviceClientChanged(newClientId) {
    if (!editingRec || serviceAddressTouchedRef.current) return null
    const next = serviceAddressAfterClientChange({ rec: editingRec, newClientId, clientAddressText: editingRec.client_address || '' })
    if (next) applyInitialServiceAddress(next)
    return next
  }

  // ---------- Catálogo (reutiliza lib/catalog.js de Fase 3) ----------
  const [userId, setUserId] = useState(null)
  const [catalogItems, setCatalogItems] = useState([])
  const [favoriteIds, setFavoriteIds] = useState(new Set())
  const [usage, setUsage] = useState({ byId: new Map(), byName: new Map() })
  // N3-C v2 — Atajos (Favoritos / + usados, máx. 5, con sus propios filtros de tipo y categoría) y Buscador (texto + tipo + categoría) son controles independientes.
  const [scMode, setScMode] = useState('favoritos') // 'favoritos' | 'usados'
  const [scType, setScType] = useState('')
  const [scCategory, setScCategory] = useState('')
  const [searchText, setSearchText] = useState('')
  const [debouncedText, setDebouncedText] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [openRes, setOpenRes] = useState({}) // resultados del buscador con el nombre completo desplegado { [itemId]: true }
  const [expanded, setExpanded] = useState({}) // conceptos con el nombre completo desplegado { [índice]: true }
  const [flash, setFlash] = useState({}) // confirmación breve de «+» { [itemId]: contador } (el contador reinicia la animación en clics seguidos)
  const [announce, setAnnounce] = useState('') // aviso para lectores de pantalla (agregado / eliminado)
  const linesRef = useRef(null)
  const ghostsRef = useRef(null)
  const flashCounter = useRef(0)
  const [dupNotice, setDupNotice] = useState('') // aviso al añadir un producto que una cotización histórica ya trae en varias filas
  const itemsRef = useRef([]) // conceptos vigentes, actualizados al instante en «+ Añadir» para que los clics seguidos vean el resultado del anterior

  // ---------- Carga inicial ----------
  useEffect(() => {
    let active = true
    async function selectExistingClient(client, preferredAddressId, preferredContactId) {
      const token = ++clientRequestRef.current
      setSelectedClientId(client.id)
      setSelectedClientRow(client)
      let addrs = [], contacts = []
      try { [addrs, contacts] = await Promise.all([fetchAddresses(client.id), fetchContacts(client.id)]) } catch { /* fallo de red: se sigue sin direcciones ni contactos */ }
      if (!active || clientRequestRef.current !== token) return { addr: null, contact: null, addrs: null, token }
      setClientAddresses(addrs)
      setClientContacts(contacts)
      const addr = (preferredAddressId && addrs.find((a) => a.id === preferredAddressId)) || addrs.find((a) => a.is_primary) || addrs[0] || null
      const contact = (preferredContactId && contacts.find((c) => c.id === preferredContactId)) || contacts.find((c) => c.is_primary) || contacts[0] || null
      setSelectedAddressId(addr ? addr.id : null)
      setSelectedContactId(contact ? contact.id : null)
      return { addr, contact, addrs, token }
    }

    async function load() {
      if (editingRec) {
        const normalizedItems = (editingRec.items || []).map(normalizeItem)
        setLoadedDraft({
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
        // Dirección de servicio guardada: se conserva desde el primer instante (como manual si aún no se pueden comparar las direcciones del cliente)...
        const clientAddressText = editingRec.client_address || ''
        applyInitialServiceAddress(initialServiceAddress({ rec: editingRec, addresses: [], selectedAddressId: null, clientAddressText }))
        if (editingRec.client_id) {
          const loadToken = clientRequestRef.current
          let ownedToken = loadToken // solicitud vigente de esta carga: al terminar (bien o mal) se libera «Cargando cliente…» solo si sigue siendo la vigente
          setClientLoading(true)
          try {
            const { data: c } = await supabase.from('clients').select('*').eq('id', editingRec.client_id).single()
            if (active && c && clientRequestRef.current === loadToken) {
              setClientMode('existente')
              const { addr, addrs, token } = await selectExistingClient(
                c,
                editingRec.client_snapshot?.selected_address?.id ?? null,
                editingRec.client_snapshot?.selected_contact?.id ?? null,
              )
              ownedToken = token
              // ...y se afina cuando ya se conocen las direcciones del cliente, solo si la persona todavía no tocó la dirección de servicio.
              if (active && clientRequestRef.current === token && !serviceAddressTouchedRef.current && addrs) {
                applyInitialServiceAddress(initialServiceAddress({ rec: editingRec, addresses: addrs, selectedAddressId: addr ? addr.id : null, clientAddressText }))
              }
              // OJO: draft.client.* ya viene de las columnas planas del registro
              // (arriba) y NO se sobreescribe aquí — es lo que realmente se
              // guardó; los selects de dirección/contacto solo sirven para que,
              // si el usuario los cambia, el nuevo snapshot lo refleje.
            }
          } finally {
            if (active && clientRequestRef.current === ownedToken) setClientLoading(false)
          }
        }
        return
      }

      if (clientIdParam) {
        const { data: client } = await supabase.from('clients').select('*').eq('id', clientIdParam).single()
        if (client && active) {
          const { addr, contact } = await selectExistingClient(client, null, null)
          setLoadedDraft({
            ...newDraft(config, initialType),
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

      setLoadedDraft(newDraft(config, initialType))
      setPreviewFolio(await nextFolio('cotizacion'))
    }
    load()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { if (typePending && confirmRef.current) confirmRef.current.focus() }, [typePending])

  useEffect(() => {
    if (justAddedIdx === null) return
    const t = setTimeout(() => setJustAddedIdx(null), 1200)
    return () => clearTimeout(t)
  }, [justAddedIdx])

  // ---------- Catálogo: una sola carga de conceptos activos; los filtros de tipo/categoría se aplican aquí, por control (atajos y buscador por separado) ----------
  useEffect(() => {
    fetchCatalogItems({ status: 'active' }).then(({ data }) => setCatalogItems(data))
  }, [])

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

  const byFilters = (list, type, category) => list.filter((it) => (!type || it.type === type) && (!category || it.category === category))

  // Atajos: máximo 5. Favoritos = los marcados por la persona; + usados = los que ya figuran en cotizaciones, ordenados con el cálculo existente (lib/catalog.js: unidades acumuladas
  // por catalog_item_id o, en datos antiguos, por nombre). Sin uso registrado no se inventa un orden: ese concepto no aparece en «+ usados».
  const SHORTCUT_LIMIT = 5
  const shortcutAll = useMemo(() => {
    const list = byFilters(catalogItems, scType, scCategory)
    return scMode === 'favoritos'
      ? list.filter((it) => favoriteIds.has(it.id))
      : sortByUsage(list.filter((it) => usageCountFor(it, usage) > 0), usage)
  }, [catalogItems, scType, scCategory, scMode, favoriteIds, usage])
  const shortcuts = shortcutAll.slice(0, SHORTCUT_LIMIT)

  const searchResults = useMemo(() => byFilters(searchInItems(catalogItems, debouncedText), filterType, filterCategory), [catalogItems, debouncedText, filterType, filterCategory])

  const categories = useMemo(() => distinctCategories(catalogItems), [catalogItems])

  // N2 — cambios sin guardar: se compara el borrador con el que fijó la carga (setLoadedDraft) y se cuentan la dirección de servicio tocada
  // a mano y el catálogo con cantidades puestas pero sin agregar. El marco (menú, barras, cerrar sesión) pregunta antes de descartarlos
  // (lib/unsavedGuard.js). No guarda nada: sin borradores entre pantallas.
  useEffect(() => { latestRef.current = { draft, staged: {} }; itemsRef.current = draft ? draft.items : [] })
  useEffect(() => {
    registerUnsavedGuard(() => {
      const { draft: d, staged } = latestRef.current
      if (!d || baselineRef.current === null) return false
      return JSON.stringify(d) !== baselineRef.current || serviceAddressTouchedRef.current || Object.keys(staged || {}).length > 0
    })
    return () => registerUnsavedGuard(null)
  }, [])

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
    if (field === 'name') {
      // Editar el nombre desvincula al cliente: se invalidan las cargas en curso y se quitan las opciones del cliente anterior (la dirección manual y los avisos se conservan).
      clientRequestRef.current++; setClientLoading(false); setSelectedClientId(null)
      setSelectedClientRow(null) // la fila del cliente anterior alimenta el snapshot: no debe quedar asociada a un cliente desvinculado
      setClientAddresses([]); setClientContacts([]); setSelectedAddressId(null); setSelectedContactId(null)
      serviceClientChanged(null)
    }
    setDraft((d) => ({ ...d, client: { ...d.client, [field]: value } }))
  }
  async function searchClientSuggestions(text) {
    if (clientMode === 'nuevo') { setClientSuggestions([]); return }
    setClientSuggestions(await searchClients(text))
  }
  async function applyClientSuggestion(c) {
    setClientSuggestions([])
    const token = ++clientRequestRef.current
    setClientLoading(true)
    setSelectedClientId(c.id)
    setSelectedClientRow(c)
    const changed = serviceClientChanged(c.id) // al instante: no depende de cuándo lleguen las direcciones
    try {
      let addrs = [], contacts = []
      try { [addrs, contacts] = await Promise.all([fetchAddresses(c.id), fetchContacts(c.id)]) } catch { /* fallo de red: se aplica el cliente sin direcciones ni contactos */ }
      if (clientRequestRef.current !== token) return // otra selección, limpieza o cambio de modo ocurrió mientras tanto
      setClientAddresses(addrs)
      setClientContacts(contacts)
      const addr = addrs.find((a) => a.is_primary) || addrs[0] || null
      const contact = contacts.find((x) => x.is_primary) || contacts[0] || null
      setSelectedAddressId(addr ? addr.id : null)
      setSelectedContactId(contact ? contact.id : null)
      // Si se volvió al cliente con el que se abrió la edición, se recupera el estado de apertura ya con sus direcciones.
      if (changed && changed.restored && !serviceAddressTouchedRef.current) {
        applyInitialServiceAddress(initialServiceAddress({ rec: editingRec, addresses: addrs, selectedAddressId: addr ? addr.id : null, clientAddressText: editingRec.client_address || '' }))
      }
      setDraft((d) => ({
        ...d,
        client: {
          name: c.name || '',
          phone: contact?.phone || c.phone || '',
          email: contact?.email || c.email || '',
          address: addr?.address || c.address || '',
        },
      }))
    } finally {
      if (clientRequestRef.current === token) setClientLoading(false) // éxito o error de la solicitud vigente; una obsoleta no toca este estado
    }
  }
  function switchClientMode(mode) {
    clientRequestRef.current++
    setClientLoading(false)
    serviceClientChanged(null)
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
  // «+ Añadir» de atajos y buscador (lib/quoteLines.js): producto nuevo = fila nueva; producto ya presente = su cantidad sube 1 y se recalcula el importe (precio y textos ya editados
  // no se tocan); el producto se identifica por catalog_item_id. Si una cotización histórica ya lo trae en VARIAS filas no se modifica nada y se avisa (el criterio de fusión se decide aparte).
  function markFlash(id) {
    const n = (flashCounter.current += 1)
    setFlash((f) => ({ ...f, [id]: n }))
    setTimeout(() => setFlash((f) => { if (f[id] !== n) return f; const g = { ...f }; delete g[id]; return g }), 900)
  }
  function addFromCatalog(item) {
    const r = addCatalogProduct(itemsRef.current, item)
    const o = r.outcome
    if (o.kind === 'ambiguous') {
      setDupNotice(`«${item.name}» ya está en ${o.count} filas de esta cotización. No se agregó ni se fusionó nada: ajusta la cantidad en la fila que corresponda.`)
      setAnnounce(`${item.name} ya está en ${o.count} filas; no se agregó nada`)
      return
    }
    itemsRef.current = r.items // los clics seguidos parten de este resultado aunque React aún no haya vuelto a pintar
    setDraft((d) => ({ ...d, items: r.items }))
    setDupNotice('')
    setJustAddedIdx(o.index)
    setAnnounce(o.kind === 'added' ? `Agregado: ${item.name}` : `Cantidad actualizada: ${item.name} ×${o.qty}`)
    markFlash(item.id)
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
    setDupNotice('')
    // los desplegados «Ver completo» siguen a su concepto cuando cambian las posiciones
    setExpanded((ex) => { const g = {}; Object.keys(ex).forEach((k) => { const i = Number(k); if (i < idx) g[i] = true; else if (i > idx) g[i - 1] = true }); return g })
  }
  // Eliminar: el concepto sale del borrador y los totales se recalculan al instante; el desvanecimiento es solo una copia visual (sin eventos) que se apaga sobre su posición anterior,
  // así no retrasa cálculos, no mueve otras filas ni intercepta clics rápidos. Con «reducir movimiento» no se crea la copia.
  function removeWithFade(idx, event) {
    const row = event.currentTarget.closest('.dn-q-line')
    const host = ghostsRef.current
    const name = (draft.items[idx] && draft.items[idx].name) || `concepto ${idx + 1}`
    if (row && host && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const hostRect = host.getBoundingClientRect(), rowRect = row.getBoundingClientRect()
      const ghost = row.cloneNode(true)
      ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'))
      const from = row.querySelectorAll('input,textarea'), to = ghost.querySelectorAll('input,textarea')
      from.forEach((el, i) => { if (to[i]) to[i].value = el.value })
      ghost.querySelectorAll('button,input,textarea,select,a').forEach((n) => { n.tabIndex = -1 })
      ghost.setAttribute('aria-hidden', 'true')
      ghost.classList.remove('dn-q-line', 'just-added') // la copia no es una fila real: no debe contarse como concepto
      ghost.classList.add('dn-q-ghost')
      ghost.style.top = `${rowRect.top - hostRect.top}px`
      ghost.style.left = `${rowRect.left - hostRect.left}px`
      ghost.style.width = `${rowRect.width}px`
      ghost.style.height = `${rowRect.height}px`
      host.appendChild(ghost)
      setTimeout(() => ghost.remove(), 300)
    }
    removeItem(idx)
    setAnnounce(`Eliminado: ${name}`)
  }

  // ---------- requires_service ----------
  function toggleRequiresService(checked) {
    setDraft((d) => ({ ...d, requiresServiceOverridden: true, requiresServiceManual: checked }))
  }
  function useAutomaticSuggestion() {
    setDraft((d) => ({ ...d, requiresServiceOverridden: false }))
  }

  // ---------- N3-C: cambio de tipo ----------
  // No borra nada: todo el borrador (cliente, conceptos, descuento, vigencia, notas, tiempo de instalación y dirección de servicio capturada) se conserva.
  // Solo cambia lo que se deriva del tipo al guardar. Si eso dejaría sin guardar o sin imprimir algo ya capturado, se explica y se pide confirmación.
  function requestTypeChange(to) {
    if (!to || to === draft.quoteType) { setTypePanelOpen(false); return }
    const resolved = resolveServiceAddress()
    const { losses, notes } = quoteTypeChangeEffects({
      from: draft.quoteType, to, items: draft.items,
      requiresServiceOverridden: draft.requiresServiceOverridden, requiresServiceManual: draft.requiresServiceManual,
      installTimeValue: draft.installTimeValue, installTimeUnit: draft.installTimeUnit,
      serviceAddress: { origin: serviceAddressOrigin, address: resolved.address || '' },
    })
    if (losses.length) { setTypePending({ to, losses, notes }); return }
    applyTypeChange(to, notes)
  }
  function applyTypeChange(to, notes) {
    setDraft((d) => ({ ...d, quoteType: to }))
    setErrors((e) => (e.quoteType ? { ...e, quoteType: undefined } : e))
    setTypePending(null)
    setTypePanelOpen(false)
    setTypeNotice(`Tipo de cotización: ${quoteTypeLabel(to)}. Se conservaron el cliente, los conceptos, las condiciones y las notas.` + (notes && notes.length ? ' ' + notes.map((n) => n.text).join(' ') : ''))
  }

  // ---------- Dirección de servicio ----------
  function resolveServiceAddress() {
    return resolveServiceAddressFor({
      origin: serviceAddressOrigin, otherAddressId: serviceOtherAddressId, manualAddress: serviceManualAddress,
      addresses: clientAddresses, selectedAddressId, draftClientAddress: draft.client.address,
    })
  }

  async function handleSubmit() {
    const { errors: errs, hasErrors } = validateQuote(draft)
    if (!editingRec && !draft.quoteType) errs.quoteType = 'Elige el tipo de cotización.'
    if (requiresService) {
      const resolved = resolveServiceAddress()
      if (serviceAddressPending) errs.serviceAddress = 'Confirma la dirección de servicio: la guardada pertenecía al cliente anterior o no se sabe de quién era (ver el aviso).'
      else if (!resolved.address || !resolved.address.trim()) errs.serviceAddress = 'Indica la dirección donde se realizará el servicio.'
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
  const typeLabel = quoteTypeLabel(draft.quoteType)
  const typeCard = QUOTE_TYPE_CARDS.find((c) => c.value === draft.quoteType)
  const lineAmount = (it) => it.subtotal ?? ((it.price || 0) * (it.qty || 0))
  // N3-C v2 — servicio según tipo: Instalación y Servicios ya lo requieren (no se pregunta); Venta de productos (y una cotización sin tipo) ofrece «solo la venta» o «agregar servicio posterior».
  // Si una cotización antigua de Instalación/Servicios quedó guardada SIN servicio requerido, se sigue mostrando la opción para no cambiar ese dato en silencio.
  const isServiceType = draft.quoteType === 'instalacion' || draft.quoteType === 'servicio'
  const serviceIsFixed = isServiceType && requiresService
  const showInstallTime = draft.quoteType !== 'venta' // el valor se conserva en memoria al ocultarse
  const LONG_NAME = 44 // buscador: a partir de aquí el nombre puede ocupar más de 2 líneas en móvil: se ofrece «Ver completo»
  const hasQuery = searchText.trim() !== '' && debouncedText.trim() !== '' // sin consulta no se lista nada (los filtros solos no muestran resultados)
  const dupProducts = duplicateCatalogProducts(draft.items)
  const addButton = (item) => (
    <button type="button" className={`dn-h-btn dn-h-primary dn-h-sm dn-q-add ${flash[item.id] ? 'is-added' : ''}`} onClick={() => addFromCatalog(item)} aria-label={`Añadir ${item.name}`}>
      <span key={flash[item.id] || 0} className="dn-q-pop"><DonnieIcon name={flash[item.id] ? 'tick' : 'plus'} /></span>
      <span className="dn-q-addtx">{flash[item.id] ? 'Añadido' : 'Añadir'}</span>
    </button>
  )

  const addressBlock = (
    <div className="dn-q-addr">
      <div className="dn-q-sublabel">Dirección de servicio</div>
      <div className="dn-q-radiolist">
        <label>
          <input type="radio" checked={serviceAddressOrigin === 'selected_client_address'} onChange={() => setServiceAddressOrigin('selected_client_address')} />
          Usar la dirección del cliente seleccionada arriba
        </label>
        {clientAddresses.length > 0 && (
          <label>
            <input type="radio" checked={serviceAddressOrigin === 'other_client_address'} onChange={() => setServiceAddressOrigin('other_client_address')} />
            Elegir otra dirección registrada del cliente
          </label>
        )}
        <label>
          <input type="radio" checked={serviceAddressOrigin === 'manual'} onChange={() => setServiceAddressOrigin('manual')} />
          Dirección manual distinta
        </label>
      </div>
      {serviceAddressOrigin === 'other_client_address' && (
        <select value={serviceOtherAddressId || ''} onChange={(e) => setServiceOtherAddressId(e.target.value)} aria-label="Otra dirección registrada del cliente">
          <option value="">— elegir dirección —</option>
          {clientAddresses.map((a) => (
            <option key={a.id} value={a.id}>{a.label ? `${a.label} — ` : ''}{a.address}</option>
          ))}
        </select>
      )}
      {serviceAddressOrigin === 'manual' && (
        <input value={serviceManualAddress} onChange={(e) => setServiceManualAddress(e.target.value)} placeholder="Dirección donde se realizará el servicio" aria-label="Dirección manual de servicio" />
      )}
      {serviceAddressPending && (
        <div className="dn-q-warnbox">
          {serviceAddressPending.kind === 'previous_client_address' ? (
            <>La dirección «{serviceAddressPending.text}» era una dirección registrada del cliente anterior y no se conserva como confirmada. Elige una dirección válida del cliente nuevo, usa la del cliente o escribe una manual.</>
          ) : (
            <>
              Esta cotización guardó «{serviceAddressPending.text}» sin registrar si era la dirección del cliente, otra registrada o una manual. Al cambiar de cliente no se puede asumir de quién es: confírmala como dirección manual o elige otra opción.{' '}
              <button type="button" className="dn-h-btn dn-h-sm" onClick={() => { const t = serviceAddressPending.text; setServiceAddressOrigin('manual'); setServiceManualAddress(t) }}>
                Conservar como dirección manual
              </button>
            </>
          )}
        </div>
      )}
      {errors.serviceAddress && <div className="fielderr">{errors.serviceAddress}</div>}
    </div>
  )

  return (
    <div className="dn-qpage">
      <div className="dn-q-top">
        <GuardedLink href="/cotizador" className="dn-h-btn dn-h-sm dn-q-back"><DonnieIcon name="left" />Volver a Cotizador</GuardedLink>
      </div>
      <h2 className="pagetitle">{editingRec ? 'Editar cotización' : 'Nueva cotización'}</h2>
      <div className="pagesub">{editingRec ? 'Edita la cotización de manera fácil y rápida. Al guardar se publica una nueva versión y se genera su PDF para que la envíes a tus clientes' : 'Crea una nueva cotización de manera fácil y rápida. Al guardar se publica la versión y se genera su PDF para que la envíes a tus clientes'}</div>
      <div className="dn-sr" role="status" aria-live="polite">{announce}</div>

      {!editingRec && baseRow && !baseRow.content_revision && (
        <div className="editbanner">
          <span>La cotización <strong>{baseRow.folio}</strong> ya fue creada pero <strong>aún no está publicada</strong> (sin PDF vigente). Al guardar se reintenta la publicación sin crear otra.</span>
        </div>
      )}

      {editingRec && (
        <div className="editbanner">
          <span>Estás editando <strong>{editingRec.folio}</strong>. Al guardar se actualiza ese mismo registro.</span>
          <GuardedLink href="/historial" className="dn-h-btn dn-h-sm">Cancelar edición</GuardedLink>
        </div>
      )}

      <div className="dn-q">
        {/* ---------- Tipo de cotización: icono + tipo actual protagonista + «Cambiar» como botón secundario ---------- */}
        <section className="dn-card dn-q-type" aria-label="Tipo de cotización" onKeyDown={(e) => { if (e.key === 'Escape' && (typePending || typePanelOpen)) { e.stopPropagation(); if (typePending) setTypePending(null); else setTypePanelOpen(false) } }}>
          <div className="dn-q-typebar">
            <span key={draft.quoteType || 'none'} className="dn-entry-ico dn-q-typeico"><DonnieIcon name={typeCard ? typeCard.icon : 'quote'} /></span>
            <div className="dn-q-typetx">
              <span className="dn-q-typelbl">Tipo de cotización</span>
              <strong className="dn-q-typeval" data-type={draft.quoteType || ''}>{typeLabel || 'Sin elegir'}</strong>
            </div>
            <button type="button" className="dn-h-btn dn-q-change" aria-expanded={typePanelOpen} aria-controls="dn-q-typepanel"
              onClick={() => { setTypePending(null); setTypePanelOpen((o) => !o) }}>
              {draft.quoteType ? 'Cambiar' : 'Elegir'}<DonnieIcon name="down" className="dn-q-chev" />
            </button>
          </div>
          {errors.quoteType && <div className="fielderr">{errors.quoteType}</div>}
          {!draft.quoteType && editingRec && (
            <div className="helptext" style={{ marginTop: 8, marginBottom: 0 }}>Esta cotización es anterior a esta clasificación — puedes dejarla sin tipo o elegir uno ahora.</div>
          )}
          {typePanelOpen && (
            <div id="dn-q-typepanel" className="dn-q-typepanel">
              <div className="dn-q-typeopts" role="group" aria-label="Tipo de cotización">
                {QUOTE_TYPE_CARDS.map((t) => (
                  <button key={t.value} type="button" className="dn-q-typeopt" data-type={t.value}
                    aria-pressed={draft.quoteType === t.value} onClick={() => requestTypeChange(t.value)}>
                    <span className="dn-entry-ico"><DonnieIcon name={t.icon} /></span>
                    <span className="dn-q-typeopt-tx">
                      <b>{t.label}{draft.quoteType === t.value ? <em> · actual</em> : null}</b>
                      <small>{t.desc}</small>
                      <small className="dn-q-typeopt-note">{t.note}</small>
                    </span>
                  </button>
                ))}
              </div>
              <p className="dn-q-typehelp">Cambiar el tipo conserva lo que ya capturaste. Las condiciones y los datos de pago del PDF se toman del tipo que quede al guardar.</p>
              {typePending && (
                <div className="dn-q-confirm" role="alertdialog" aria-labelledby="dn-q-confirm-t" aria-describedby="dn-q-confirm-d" tabIndex={-1} ref={confirmRef}>
                  <b id="dn-q-confirm-t">¿Cambiar a «{quoteTypeLabel(typePending.to)}»?</b>
                  <p id="dn-q-confirm-d">Se conserva todo lo que capturaste, salvo lo siguiente, que con este tipo no se guardaría o no se imprimiría:</p>
                  <ul>{typePending.losses.map((l) => <li key={l.id}>{l.text}</li>)}</ul>
                  <p>Si vuelves a elegir un tipo que lo use antes de guardar, se recupera tal como está.</p>
                  <div className="dn-q-confirm-btns">
                    <button type="button" className="dn-h-btn dn-h-primary" onClick={() => applyTypeChange(typePending.to, typePending.notes)}>Cambiar a {quoteTypeLabel(typePending.to)}</button>
                    <button type="button" className="dn-h-btn" onClick={() => setTypePending(null)}>Cancelar</button>
                  </div>
                </div>
              )}
              {!typePending && draft.quoteType && (
                <button type="button" className="dn-h-btn dn-h-sm dn-q-typeclose" onClick={() => setTypePanelOpen(false)}>Cerrar</button>
              )}
            </div>
          )}
          {typeNotice && (
            <div className="dn-q-notice" role="status">
              <span>{typeNotice}</span>
              <button type="button" className="dn-h-btn dn-h-sm" onClick={() => setTypeNotice('')} aria-label="Cerrar aviso">Entendido</button>
            </div>
          )}
        </section>

        {/* ---------- Cliente ---------- */}
        <section className="dn-card dn-q-sec" aria-labelledby="dn-q-h-cliente">
          <h3 id="dn-q-h-cliente"><span className="dn-q-ico"><DonnieIcon name="users" /></span>Cliente</h3>
          <p className="dn-q-sdesc">Elige o captura el cliente, agrega los conceptos y las condiciones</p>
          {!editingRec && !clientIdParam && (
            <div className="dn-q-modes" role="radiogroup" aria-label="Tipo de cliente">
              <label className="dn-q-mode">
                <input type="radio" checked={clientMode === 'nuevo'} onChange={() => switchClientMode('nuevo')} /><span>Nuevo cliente</span>
              </label>
              <label className="dn-q-mode">
                <input type="radio" checked={clientMode === 'existente'} onChange={() => switchClientMode('existente')} /><span>Cliente existente</span>
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
        </section>

        {/* ---------- Conceptos ---------- */}
        <section className="dn-card dn-q-sec" aria-labelledby="dn-q-h-conceptos">
          <h3 id="dn-q-h-conceptos"><span className="dn-q-ico"><DonnieIcon name="list" /></span>Conceptos</h3>

          {/* Atajos: Favoritos / + usados (máx. 5, solo título y «+ Añadir») */}
          <div className="dn-q-block dn-q-shortcuts" aria-labelledby="dn-q-h-atajos">
            <div className="dn-q-bh">
              <span className="dn-q-ico dn-q-ico-sm"><DonnieIcon name="trend" /></span>
              <div>
                <h4 id="dn-q-h-atajos">Atajos</h4>
                <p className="dn-q-bdesc">Añade los productos más populares de tu catálogo rápidamente</p>
              </div>
            </div>
            <div className="dn-q-modes dn-q-scmodes" role="radiogroup" aria-label="Tipo de atajo">
              <label className="dn-q-mode"><input type="radio" name="dn-q-sc" checked={scMode === 'favoritos'} onChange={() => setScMode('favoritos')} /><span><DonnieIcon name="star" className="dn-q-orange dn-q-orange-fill" />Favoritos</span></label>
              <label className="dn-q-mode"><input type="radio" name="dn-q-sc" checked={scMode === 'usados'} onChange={() => setScMode('usados')} /><span><b className="dn-q-orange dn-q-plus" aria-hidden="true">+</b> usados</span></label>
            </div>
            <div className="dn-q-filterrow">
              <label className="dn-q-fsel"><span>Tipo</span>
                <select value={scType} onChange={(e) => setScType(e.target.value)} aria-label="Tipo de los atajos">
                  <option value="">Todos</option><option value="producto">Producto</option><option value="servicio">Servicio</option>
                </select>
              </label>
              <label className="dn-q-fsel"><span>Categoría</span>
                <select value={scCategory} onChange={(e) => setScCategory(e.target.value)} aria-label="Categoría de los atajos">
                  <option value="">Todas</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </div>
            {shortcuts.length === 0 ? (
              <div className="dn-q-empty">{scMode === 'favoritos' ? 'Aún no tienes favoritos con estos filtros. Márcalos con la estrella en los resultados del buscador.' : 'Aún no hay conceptos usados en cotizaciones con estos filtros.'}</div>
            ) : (
              <ul className="dn-q-sclist">
                {shortcuts.map((item) => (
                  <li key={item.id}>
                    <span className="dn-q-sctitle" title={item.name}>{item.name}</span>
                    {addButton(item)}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Buscador de productos (independiente de los atajos): sin consulta no muestra resultados */}
          <div className="dn-q-block dn-q-search" aria-labelledby="dn-q-h-buscar">
            <div className="dn-q-bh">
              <span className="dn-q-ico dn-q-ico-sm dn-q-ico-solid"><DonnieIcon name="search" /></span>
              <div>
                <h4 id="dn-q-h-buscar">Buscar en el catálogo</h4>
                <p className="dn-q-bdesc">Busca por nombre, SKU, categoría, etiquetas o ficha técnica</p>
              </div>
            </div>
            <label className="dn-h-search dn-q-bigsearch">
              <DonnieIcon name="search" />
              <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Escribe el producto o servicio que buscas" aria-label="Buscar en el catálogo (nombre, SKU, categoría, tags, ficha técnica)" />
            </label>
            <div className="dn-q-filterrow">
              <label className="dn-q-fsel"><span>Tipo</span>
                <select value={filterType} onChange={(e) => setFilterType(e.target.value)} aria-label="Tipo del buscador">
                  <option value="">Todos</option><option value="producto">Producto</option><option value="servicio">Servicio</option>
                </select>
              </label>
              <label className="dn-q-fsel"><span>Categoría</span>
                <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} aria-label="Categoría del buscador">
                  <option value="">Todas</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </div>
            {!hasQuery ? (
              <div className="dn-q-prompt">Escribe en el buscador para ver resultados. Los filtros se aplican a lo que busques.</div>
            ) : (
              <div className="dn-q-cat" role="list" aria-label="Resultados del catálogo">
                {!searchResults.length ? (
                  <div className="dn-q-empty">No hay productos o servicios que coincidan.</div>
                ) : searchResults.map((item) => (
                  <div key={item.id} className="dn-q-crow" role="listitem">
                    <div className="dn-q-cname">
                      <div className={`dn-q-cname-t ${openRes[item.id] ? 'is-open' : ''}`} title={item.name}>{item.name}</div>
                      {item.description && <div className="dn-q-cdesc" title={item.description}>{item.description}</div>}
                      {String(item.name || '').length > LONG_NAME && (
                        <button type="button" className="dn-q-more" aria-expanded={!!openRes[item.id]} onClick={() => setOpenRes((o) => ({ ...o, [item.id]: !o[item.id] }))}>
                          {openRes[item.id] ? 'Ver menos' : 'Ver completo'}
                        </button>
                      )}
                    </div>
                    <span className="dn-q-cprice">{fmt(item.price)}</span>
                    <button type="button" className={`dn-q-star ${favoriteIds.has(item.id) ? 'is-fav' : ''}`}
                      title={favoriteIds.has(item.id) ? 'Quitar de favoritos' : 'Marcar como favorito'}
                      aria-label={favoriteIds.has(item.id) ? `Quitar de favoritos: ${item.name}` : `Marcar como favorito: ${item.name}`}
                      aria-pressed={favoriteIds.has(item.id)} onClick={() => toggleCatalogFavorite(item)} disabled={!userId}
                    ><DonnieIcon name="star" /></button>
                    {addButton(item)}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Conceptos agregados */}
          <div className="dn-q-block dn-q-added" aria-labelledby="dn-q-h-agregados">
            <div className="dn-q-block-head">
              <h4 id="dn-q-h-agregados">Conceptos de la cotización</h4>
              <span className="dn-q-count">{draft.items.length}</span>
            </div>
            {errors.items && <div className="fielderr">{errors.items}</div>}
            {dupProducts.length > 0 && (
              <div className="dn-q-dupinfo" role="note">
                Esta cotización ya tenía el mismo producto en varias filas ({dupProducts.map((p) => `«${p.name}» ×${p.count}`).join(', ')}). No se fusionaron; para no cambiarla sin avisar, «Añadir» no modifica esas filas: ajusta la cantidad directamente.
              </div>
            )}
            {dupNotice && <div className="dn-q-dupnotice" role="status">{dupNotice}</div>}
            {!draft.items.length && <div className="dn-q-empty">Aún no hay conceptos. Agrégalos con los atajos o el buscador, o escribe uno manual.</div>}
            <div className="dn-q-lines" ref={linesRef}>
              {draft.items.map((it, idx) => (
                <div key={idx} className={`dn-q-line ${idx === justAddedIdx ? 'just-added' : ''}`} data-source={it.source || 'manual'}>
                  <div className="dn-q-lname">
                    <span className="dn-q-lbl">{it.source === 'catalog' ? 'Concepto del catálogo' : 'Concepto manual'}</span>
                    {(() => {
                      // Presentación de título y descripción (N3-C; la separación definitiva del catálogo es de N3-E):
                      //  - con descripción separada (it.description): título completo y resumen de la descripción (≤68 caracteres);
                      //  - con un solo texto combinado (todos los conceptos actuales): ese texto se muestra resumido y se despliega para consultarlo y editarlo.
                      // El texto guardado no se recorta nunca; solo cambia lo que se muestra.
                      const hasDesc = typeof it.description === 'string' && it.description.trim() !== ''
                      const open = !!expanded[idx]
                      const toggle = (label) => (
                        <button type="button" className="dn-q-more" aria-expanded={open} onClick={() => setExpanded((ex) => ({ ...ex, [idx]: !ex[idx] }))}>{label}</button>
                      )
                      const nameField = (rows) => (
                        <textarea className={itemErr(idx, 'name') ? 'input-error' : ''} rows={rows} value={it.name} placeholder="Descripción del concepto" aria-label={`Descripción del concepto ${idx + 1}`}
                          onChange={(e) => updateItem(idx, 'name', e.target.value.replace(/[\r\n]+/g, ' '))} />
                      )
                      if (hasDesc) {
                        const sd = summarizeText(it.description)
                        return (
                          <>
                            {nameField(2)}
                            <div className="dn-q-ldesc">{open || !sd.truncated ? it.description : sd.text}</div>
                            {sd.truncated && toggle(open ? 'Ver menos' : 'Ver completo')}
                          </>
                        )
                      }
                      const sn = summarizeText(it.name)
                      if (sn.truncated && !open) {
                        return (
                          <>
                            <div className="dn-q-lsummary" title={it.name} data-testid="line-summary">{sn.text}</div>
                            {toggle('Ver completo')}
                          </>
                        )
                      }
                      return (
                        <>
                          {nameField(sn.truncated ? Math.min(10, Math.max(2, Math.ceil(String(it.name || '').length / 46))) : 2)}
                          {sn.truncated && toggle('Ver menos')}
                        </>
                      )
                    })()}
                    {itemErr(idx, 'name') && <div className="fielderr">{itemErr(idx, 'name')}</div>}
                  </div>
                  <div className="dn-q-lprice">
                    <span className="dn-q-lbl">Precio unitario</span>
                    <input className={itemErr(idx, 'price') ? 'input-error' : ''} type="number" min="0" step="0.01" value={it.price} aria-label={`Precio unitario del concepto ${idx + 1}`}
                      onChange={(e) => updateItem(idx, 'price', e.target.value === '' ? '' : parseFloat(e.target.value))} />
                    {itemErr(idx, 'price') && <div className="fielderr">{itemErr(idx, 'price')}</div>}
                  </div>
                  <div className="dn-q-lqty">
                    <span className="dn-q-lbl">Cantidad</span>
                    <input className={itemErr(idx, 'qty') ? 'input-error' : ''} type="number" min="1" step="1" value={it.qty} aria-label={`Cantidad del concepto ${idx + 1}`}
                      onChange={(e) => updateItem(idx, 'qty', e.target.value === '' ? '' : parseInt(e.target.value))} />
                    {itemErr(idx, 'qty') && <div className="fielderr">{itemErr(idx, 'qty')}</div>}
                  </div>
                  <div className="dn-q-lamt"><span className="dn-q-lbl">Importe</span><span className="dn-q-amt">{fmt(lineAmount(it))}</span></div>
                  <button type="button" className="dn-q-del" onClick={(e) => removeWithFade(idx, e)} aria-label={`Eliminar el concepto ${idx + 1}`} title="Eliminar concepto"><DonnieTrash /></button>
                </div>
              ))}
              <div className="dn-q-ghosts" ref={ghostsRef} aria-hidden="true" />
            </div>
            <button type="button" className="dn-h-btn dn-h-sm dn-q-addmanual" onClick={addBlankItem}><DonnieIcon name="plus" />Agregar concepto manual</button>
          </div>
        </section>

        {/* ---------- Servicio (Instalación/Servicios: ubicación; Venta: solo venta o servicio posterior) ---------- */}
        <section className="dn-card dn-q-sec" aria-labelledby="dn-q-h-servicio">
          <h3 id="dn-q-h-servicio"><span className="dn-q-ico"><DonnieIcon name={serviceIsFixed ? 'building' : 'truck'} /></span>{serviceIsFixed ? 'Ubicación del servicio' : 'Servicio posterior'}</h3>
          {serviceIsFixed ? (
            <p className="dn-q-svcnote">{typeLabel} incluye servicio en el sitio del cliente; indica dónde se realizará.</p>
          ) : (
            <>
              <div className="dn-q-modes dn-q-svcopts" role="radiogroup" aria-label="¿Requiere servicio o instalación posterior?">
                <label className="dn-q-mode"><input type="radio" name="dn-q-svc" checked={!requiresService} onChange={() => toggleRequiresService(false)} /><span>Solo la venta</span></label>
                <label className="dn-q-mode"><input type="radio" name="dn-q-svc" checked={requiresService} onChange={() => toggleRequiresService(true)} /><span>Agregar servicio posterior</span></label>
              </div>
              <p className="dn-q-svcnote">{draft.requiresServiceOverridden ? 'Elegiste esta opción a mano.' : 'La opción se sugiere según los conceptos agregados (por ejemplo, si incluyes conceptos de servicio).'}</p>
              {draft.requiresServiceOverridden && (
                <button type="button" className="dn-h-btn dn-h-sm" onClick={useAutomaticSuggestion}>Usar recomendación automática</button>
              )}
            </>
          )}
          {requiresService && addressBlock}
        </section>

        {/* ---------- Condiciones ---------- */}
        <section className="dn-card dn-q-sec" aria-labelledby="dn-q-h-condiciones">
          <h3 id="dn-q-h-condiciones"><span className="dn-q-ico"><DonnieIcon name="receipt" /></span>Condiciones</h3>
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
            <div className="field">
              <label>Vigencia (días)</label>
              <input type="number" min="1" value={draft.validDays} onChange={(e) => setDraft((d) => ({ ...d, validDays: parseInt(e.target.value) || 1 }))} />
            </div>
            {showInstallTime && (
              <div className="field">
                <label>Tiempo de instalación estimado (opcional)</label>
                <div className="dn-q-install">
                  <input
                    type="number" min="0" step="0.5" aria-label="Tiempo de instalación estimado"
                    value={draft.installTimeValue}
                    onChange={(e) => setDraft((d) => ({ ...d, installTimeValue: e.target.value === '' ? '' : parseFloat(e.target.value) }))}
                  />
                  <select
                    aria-label="Unidad del tiempo de instalación"
                    value={draft.installTimeUnit}
                    onChange={(e) => setDraft((d) => ({ ...d, installTimeUnit: e.target.value }))}
                  >
                    <option value="horas">Horas</option>
                    <option value="dias">Días</option>
                  </select>
                </div>
              </div>
            )}
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Notas para el cliente (opcional)</label>
            <textarea value={draft.notes} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
          </div>
        </section>

        {/* ---------- Totales ---------- */}
        <section className="dn-q-totals" aria-labelledby="dn-q-h-totales">
          <h3 id="dn-q-h-totales" className="dn-q-h-totales"><span className="dn-q-ico"><DonnieIcon name="cash" /></span>Totales</h3>
          <div className="ticket">
            <div className="ticket-head">
              {config.logo_url && <img src={config.logo_url} alt="" style={{ width: 30, height: 30, objectFit: 'contain', background: '#fff', borderRadius: 3, padding: 2 }} />}
              <div style={{ minWidth: 0 }}>
                <div className="co">{config.company_name}</div>
                <div className="meta">
                  FOLIO {displayFolio} · VIGENCIA {draft.validDays} DÍAS
                  {showInstallTime && draft.installTimeValue !== '' && draft.installTimeValue != null && (
                    <> · INSTALACIÓN EST. {draft.installTimeValue} {draft.installTimeUnit === 'dias' ? 'DÍAS' : 'HORAS'}</>
                  )}
                </div>
              </div>
            </div>
            <div className="ticket-body">
              {draft.items.length ? draft.items.map((it, idx) => (
                <div className="ticket-line" key={idx}>
                  <span>{it.name || '—'} <span className="muted">×{it.qty || 0}</span></span>
                  <span>{fmt(lineAmount(it))}</span>
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
        </section>

        {/* ---------- Acción final (después de las condiciones y los totales) ---------- */}
        <section className="dn-card dn-q-final" aria-label="Guardar cotización">
          <p className="dn-q-final-note">
            <DonnieIcon name="receipt" />
            <span><b>Guardar cotización</b> {editingRec ? 'publica una nueva versión de esta cotización' : 'publica esta versión'} y genera su PDF, que se descarga al terminar. No es un borrador.</span>
          </p>
          <div className="actionsbar">
            <button type="button" className="dn-h-btn dn-h-primary dn-q-save" disabled={saving || clientLoading} onClick={handleSubmit}>
              {saving ? 'Guardando…' : clientLoading ? 'Cargando cliente…' : 'Guardar cotización'}
            </button>
            <GuardedLink href="/historial" className="dn-h-btn">Cancelar</GuardedLink>
          </div>
        </section>
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
  const tipoParam = parseQuoteTypeParam(params.get('tipo')) // N3-A: solo valores existentes; se ignora en ediciones

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

  // N2 (menú Donnie): «Cotizador» / «Nueva cotización» desde una edición cambia la URL a /cotizar sin desmontar esta pantalla; sin esto el estado `editingRec`
  // quedaba pegado y el formulario seguía mostrando (y guardando sobre) la cotización editada. Sin ?edit= no hay cotización en edición, y el formulario
  // se monta de nuevo (key) para empezar limpio.
  const rec = editId ? editingRec : null

  // Fase 6.6B — después de contratar, la cotización (y su recibo) quedan
  // congelados; cancelar una contratación tampoco la vuelve editable. La
  // única cotización editable es la que sigue en lifecycle_status='cotizacion'.
  // Si editId apunta a una que ya no lo está, no se renderiza ningún
  // formulario — antes esto se resolvía con LegacyContractedEditForm
  // (retirado, ver arriba), que sí permitía escribir directamente sobre una
  // contratada y su recibo.
  if (rec && !canEditQuote(rec)) {
    return (
      <div>
        <h2 className="pagetitle">Cotización no editable</h2>
        <div className="pagesub">
          <strong>{rec.folio}</strong> ya no se puede editar: está {rec.lifecycle_status === 'cancelado' ? 'cancelada' : 'contratada'}.
          {rec.lifecycle_status === 'contratado' && ' Para revertir la contratación, usa "Cancelar contratación" desde Historial.'}
        </div>
        <button className="btn ghost" onClick={() => router.push('/historial')}>Volver a Historial</button>
      </div>
    )
  }
  return <NewQuoteForm key={editId || 'nueva'} editingRec={rec} config={config} clientIdParam={clientIdParam} initialType={rec ? '' : tipoParam} router={router} />
}

export default function CotizarPage() {
  return (
    <Suspense fallback={<div>Cargando…</div>}>
      <CotizarInner />
    </Suspense>
  )
}
