// app/historial/page.js
'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { fmt, isValidEmail, isValidPhone10 } from '@/lib/calc'
import { fillTemplate } from '@/lib/templates'
import { resolveQuoteLink } from '@/lib/quoteLinkClient'
import { createLinkCache, prefetchLink, linkForSend } from '@/lib/sendLink'
import { triggerPdfDownload, resolveQuoteDownload } from '@/lib/pdf'
import { contractQuoteFlow } from '@/lib/quoteContracting'
import { getHistoricalLogoPath, removePaths } from '@/lib/quoteLogo'
import { getQuotePdfPath, removeQuoteRevisionFiles } from '@/lib/quotePdfStorage'
import { describeCleanupPending } from '@/lib/storageVerifiedRemove'
import { canDeleteQuote } from '@/lib/quoteLifecycle'
import { groupServicesByQuote, resolveQuoteServiceView, serviceActionHref } from '@/lib/quoteServiceView'
import {
  PAGE_SIZES, DEFAULT_PAGE_SIZE, STATE_FILTERS, TYPE_FILTERS, COMMERCIAL, stateOf,
  totalPages as pagesFor, clampPage, pageRange, pageWindow, pageWindow3, shortName, buildReceiptsByFolio, filterRecords, recordActions,
} from '@/lib/historialView'
import { QUOTE_TYPE_CARDS } from '@/lib/quoteTypes'
import ActionMenu from '@/components/ActionMenu'
import DonnieIcon from '@/components/DonnieIcon'
import LinkManager from '@/components/LinkManager'
import { defaultRpc, detectLinkCapability, loadLinkStates, canManageLink, canRegenerateLink, guardedDownload } from '@/lib/linkManagement'
import {
  loadHistorialData, logHistorialFailures, createLoadTracker,
  HISTORIAL_LOAD_ERROR_MESSAGE, HISTORIAL_REFRESH_ERROR_MESSAGE,
} from '@/lib/historialLoad'

// Etiqueta del tipo de cotización (los valores EXISTENTES de quotes.quote_type); los registros antiguos sin tipo no muestran etiqueta.
const TYPE_LABEL = Object.fromEntries(QUOTE_TYPE_CARDS.map((t) => [t.value, t.label]))
// Estado del enlace del PDF (P-TOKEN): texto corto del chip por estado devuelto por lib/linkManagement.js.
const LINK_CHIP = { current: ['rec', 'Enlace vigente'], no_active: ['can', 'Enlace revocado'], outdated: ['cot', 'Enlace anterior'], unknown: ['neutral', 'Enlace sin verificar'] }

export default function HistorialPage() {
  const [quotes, setQuotes] = useState([])
  const [quotesTotal, setQuotesTotal] = useState(0) // total REAL en la base (puede ser mayor que lo cargado: PostgREST corta a 1000 filas)
  const [stateFilter, setStateFilter] = useState('all') // all | cotizacion | contratado | cancelado (lifecycle_status)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [services, setServices] = useState([]) // para saber qué cotizaciones ya tienen servicio
  const [config, setConfig] = useState(null)
  const [searchText, setSearchText] = useState('')
  const [searchDate, setSearchDate] = useState('')
  const [typeFilter, setTypeFilter] = useState('all') // all | cotizacion | recibo
  const [page, setPage] = useState(1)
  const [viewEpoch, setViewEpoch] = useState(0) // cambia con la página, los filtros, la búsqueda y el tamaño: cierra recibos desplegados y menús «⋯» (solo estado visual)
  const [expanded, setExpanded] = useState({}) // id de cotización -> true si su recibo está desplegado
  const [contractingId, setContractingId] = useState(null) // id de la quote que se está contratando (evita doble clic)
  const [cancellingId, setCancellingId] = useState(null) // id de la quote que se está cancelando
  const [loadState, setLoadState] = useState('loading') // loading | ready | error
  const [errorKind, setErrorKind] = useState('load') // load | refresh (la acción ya se completó)
  const [busy, setBusy] = useState(false) // hay una consulta en curso
  const trackerRef = useRef(createLoadTracker())
  // P-TOKEN — «Gestionar enlace»: la capacidad (¿están habilitadas las operaciones en la base?) se detecta en cada carga con una lectura de solo lectura;
  // si no están disponibles NO se ofrece nada. Los avisos por fila (enlace del PDF revocado / generación anterior / sin verificar) se leen solo para
  // las cotizaciones precontractuales publicadas más recientes.
  const [linkCap, setLinkCap] = useState({ state: 'unknown' })
  const [linkStates, setLinkStates] = useState({})
  const [managingId, setManagingId] = useState(null)
  const linkSeqRef = useRef(0)
  const linkCacheRef = useRef(createLinkCache()) // enlaces de {link} ya pedidos (ver lib/sendLink.js)
  const router = useRouter()

  // La carga es todo-o-nada (lib/historialLoad.js): o llegan quotes, app_config
  // y services completos, o la pantalla pasa a 'error' con «Reintentar» — nunca
  // se queda en «Cargando…» ni pinta una lista vacía por un fallo. Nunca lanza.
  // `afterAction`: la recarga viene de una acción de negocio YA completada; si
  // falla, el aviso lo dice y no sugiere repetir la acción. Solo la solicitud
  // más reciente escribe el estado (una respuesta antigua se descarta).
  async function load({ afterAction = false } = {}) {
    const id = trackerRef.current.begin()
    setBusy(true)
    const result = await loadHistorialData(supabase)
    trackerRef.current.finish(id)
    if (!trackerRef.current.isCurrent(id)) return { ok: result.ok, stale: true }
    setBusy(false)
    if (!result.ok) {
      logHistorialFailures(result.failures)
      setErrorKind(afterAction ? 'refresh' : 'load')
      setLoadState('error')
      return { ok: false }
    }
    setQuotes(result.quotes)
    setQuotesTotal(result.quotesTotal)
    setConfig(result.config)
    setServices(result.services)
    setLoadState('ready')
    return { ok: true }
  }
  function retry() {
    if (trackerRef.current.pending()) return // ya hay una consulta en curso: sin solicitudes superpuestas
    load({ afterAction: errorKind === 'refresh' })
  }
  useEffect(() => { const t = trackerRef.current; t.start(); return () => t.stop() }, [])
  useEffect(() => { load() }, [])
  // La página se reinicia en los manejadores de filtros/tamaño y, además, la página mostrada siempre se acota al rango válido (ver `curPage`).
  useEffect(() => {
    if (loadState !== 'ready') return undefined
    let cancelled = false
    const seq = ++linkSeqRef.current
    ;(async () => {
      const probe = quotes.find(canManageLink)
      const cap = await detectLinkCapability(defaultRpc, probe ? probe.id : null)
      if (cancelled || seq !== linkSeqRef.current) return
      setLinkCap(cap)
      if (cap.state !== 'enabled') setLinkStates({})
    })()
    return () => { cancelled = true }
  }, [loadState, quotes])

  // Fase 6.7C-1.3 — todos los servicios de cada cotización (antes se guardaba
  // solo el último por quote_id). La decisión de etiquetas y acción vive en
  // lib/quoteServiceView.js.
  const servicesByQuoteId = useMemo(() => groupServicesByQuote(services), [services])

  // Un recibo se relaciona con su cotización por `related_folio` (relación que
  // ya existía). Se muestra como hijo de su cotización; si por datos antiguos
  // no tiene cotización padre, se conserva como registro independiente para
  // no perderlo.
  const receiptsByFolio = useMemo(() => buildReceiptsByFolio(quotes), [quotes])

  // Paginación (lib/historialView.js): 1) se filtra TODO lo cargado, 2) se cuenta, 3) se acota la página al rango válido, 4) se rebana. El total que se
  // muestra es el de los resultados filtrados; si lo cargado es un subconjunto de la base (quotesTotal > quotes.length) la pantalla lo avisa.
  const filtered = useMemo(
    () => filterRecords({ quotes, receiptsByFolio, text: searchText, date: searchDate, type: typeFilter, state: stateFilter }),
    [quotes, receiptsByFolio, searchText, searchDate, typeFilter, stateFilter]
  )
  // Contadores de los chips = resultados que mostraría cada chip con el resto de filtros activos (nunca un conteo distinto al de la lista).
  const typeCounts = useMemo(
    () => Object.fromEntries(TYPE_FILTERS.map((f) => [f.value, filterRecords({ quotes, receiptsByFolio, text: searchText, date: searchDate, type: f.value, state: stateFilter }).length])),
    [quotes, receiptsByFolio, searchText, searchDate, stateFilter]
  )
  const stateCounts = useMemo(
    () => Object.fromEntries(STATE_FILTERS.map((f) => [f.value, filterRecords({ quotes, receiptsByFolio, text: searchText, date: searchDate, type: typeFilter, state: f.value }).length])),
    [quotes, receiptsByFolio, searchText, searchDate, typeFilter]
  )
  const totalPages = pagesFor(filtered.length, pageSize)
  const curPage = clampPage(page, totalPages)
  const pageItems = filtered.slice((curPage - 1) * pageSize, curPage * pageSize)
  const range = pageRange(curPage, pageSize, filtered.length)
  const truncated = quotesTotal > quotes.length
  const filtersActive = !!(searchText.trim() || searchDate || typeFilter !== 'all' || stateFilter !== 'all')
  const listTopRef = useRef(null)
  function resetView() { setExpanded({}); setViewEpoch((e) => e + 1) }
  function goToPage(n) {
    resetView()
    setPage(clampPage(n, totalPages))
    if (listTopRef.current) listTopRef.current.scrollIntoView({ block: 'start' })
  }
  function onFilter(setter) { return (value) => { resetView(); setter(value); setPage(1) } }
  const changeSearch = onFilter(setSearchText), changeDate = onFilter(setSearchDate), changeType = onFilter(setTypeFilter), changeState = onFilter(setStateFilter)
  function changePageSize(n) { resetView(); setPageSize(PAGE_SIZES.includes(n) ? n : DEFAULT_PAGE_SIZE); setPage(1) }
  function clearFilters() { resetView(); setSearchText(''); setSearchDate(''); setTypeFilter('all'); setStateFilter('all'); setPage(1) }
  // Estado del enlace de cada cotización precontractual publicada de la PÁGINA VISIBLE (una lectura de solo lectura por fila). Mientras no se haya consultado una fila
  // (otra página, contratadas/canceladas, o una consulta fallida) se muestra «ENLACE NO CONSULTADO»: la ausencia de aviso nunca se presenta como verificada.
  const visibleLinkRows = pageItems.filter((q) => canManageLink(q) && canRegenerateLink(q))
  const visibleLinkKey = visibleLinkRows.map((q) => q.id + ':' + q.content_revision).join(',')
  useEffect(() => {
    if (loadState !== 'ready' || linkCap.state !== 'enabled') return undefined
    let cancelled = false
    ;(async () => {
      const states = await loadLinkStates(defaultRpc, visibleLinkRows)
      if (!cancelled) setLinkStates((prev) => ({ ...prev, ...states }))
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadState, linkCap.state, visibleLinkKey, quotes])

  if (loadState === 'loading') return <div>Cargando…</div>
  if (loadState === 'error') {
    return (
      <div>
        <h2 className="pagetitle">Mis cotizaciones</h2>
        <div className="pagesub">Todas tus cotizaciones y recibos.</div>
        <div className="panel">
          <div className="muted" style={{ padding: 30, textAlign: 'center' }}>
            <div role="alert" style={{ marginBottom: 12 }}>
              {errorKind === 'refresh' ? HISTORIAL_REFRESH_ERROR_MESSAGE : HISTORIAL_LOAD_ERROR_MESSAGE}
            </div>
            <button className="btn teal small" disabled={busy} onClick={retry}>{busy ? 'Reintentando…' : 'Reintentar'}</button>
          </div>
        </div>
      </div>
    )
  }

  // P-TOKEN: antes de descargar el PDF de una versión se consulta (solo lectura, AHORA) el vínculo de ESA versión; si su enlace está revocado, fue
  // reemplazado, es desconocido o no se pudo consultar, se explica y se pide confirmación explícita. Nunca crea, regenera ni registra nada.
  async function downloadPdf(rec) {
    await guardedDownload({
      rec, rpc: defaultRpc, confirm: (m) => window.confirm(m),
      download: async (r) => {
        const result = await resolveQuoteDownload(r, config)
        if (!result.ok) { alert(result.message); return result }
        triggerPdfDownload(result.blob, result.filename)
        return result
      },
    })
  }

  // ---------- Correo: manual (adjuntar tú mismo). Ya NO descarga el PDF de
  // nuevo — ese archivo ya se descargó cuando se creó el registro (o al
  // marcarlo como contratado); aquí solo se abre el correo con la plantilla
  // lista, para no acumular descargas repetidas. Si necesitas el PDF otra
  // vez, está el botón "PDF" a un lado. Abrimos el correo de inmediato, de
  // forma síncrona: los celulares solo permiten abrir apps externas
  // mientras dura el "gesto" del clic. ----------
  // Fase 6.7 / bloque 6 — {link}: enlace de aceptación en línea. Solo cotizaciones modernas, precontractuales y publicadas (en el resto
  // se omite la línea de {link}); se prepara al abrir «Enviar a» (ver lib/sendLink.js). No se envía nada automáticamente.
  function quoteTemplates() {
    return [config.email_subject_template, config.email_body_template, config.whatsapp_template]
  }
  function prefetchSendLink(rec) {
    prefetchLink({ cache: linkCacheRef.current, rec, templates: quoteTemplates(), resolver: resolveQuoteLink })
  }
  // Devuelve el enlace ('' si no corresponde), false si el usuario canceló, o una Promesa si aún no está listo.
  function sendLinkFor(rec, templates) {
    return linkForSend({ cache: linkCacheRef.current, rec, templates, resolver: resolveQuoteLink, confirm: (m) => window.confirm(m) })
  }

  async function sendByEmail(rec) {
    if (!isValidEmail(rec.client_email)) {
      alert('Este cliente no cuenta con un correo capturado (o no tiene un formato válido). Edita el registro para agregarlo antes de enviarlo por correo.')
      return
    }
    const isReceipt = rec.status === 'recibo'
    const subjectTpl = isReceipt ? config.receipt_email_subject_template : config.email_subject_template
    const bodyTpl = isReceipt ? config.receipt_email_body_template : config.email_body_template
    let link = sendLinkFor(rec, [subjectTpl, bodyTpl])
    if (link instanceof Promise) link = await link
    if (link === false) return
    const subject = fillTemplate(subjectTpl, rec, config, { link })
    const body = fillTemplate(bodyTpl, rec, config, { link })
    window.location.href = `mailto:${rec.client_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }

  // ---------- WhatsApp: mismo principio, ya sin descarga automática. ----------
  async function sendByWhatsapp(rec) {
    if (!isValidPhone10(rec.client_phone)) {
      alert('Este cliente no cuenta con un teléfono capturado a 10 dígitos. Edita el registro para agregarlo antes de enviarlo por WhatsApp.')
      return
    }
    const digits = rec.client_phone.replace(/\D/g, '')
    const isReceipt = rec.status === 'recibo'
    const waTpl = isReceipt ? config.receipt_whatsapp_template : config.whatsapp_template
    let link = sendLinkFor(rec, [waTpl])
    if (link instanceof Promise) link = await link
    if (link === false) return
    const text = fillTemplate(waTpl, rec, config, { link })
    window.open(`https://wa.me/52${digits}?text=${encodeURIComponent(text)}`, '_blank')
  }

  // Fase 6.6B — contratar es ahora una única operación atómica en DB
  // (contract_quote, Fase 6.6A). El único trabajo que sigue haciendo el
  // cliente es lo que la RPC no puede hacer por sí misma: asegurar el PDF en
  // Storage ANTES de llamarla (Postgres no puede verificar bytes en
  // Storage). Nunca se reconstruye la transición escribiendo varias tablas
  // desde JS — eso quedaría fuera de la transacción y podría dejar estados
  // parciales, que es exactamente lo que la RPC existe para impedir.
  async function contractQuote(src) {
    // Fase 6.7C-1.1 — el camino (revisión 6.7 / legacy 6.6) se decide dentro de
    // contractQuoteFlow con la fila FRESCA de la DB, no con `src` (el listado
    // puede estar viejo): solo se le pasa el id. Ver lib/quoteContracting.js.
    setContractingId(src.id)
    const result = await contractQuoteFlow(src.id)
    setContractingId(null)
    if (!result.ok) {
      // Fallo/aborto: la contratación NO se confirmó — el estado anterior
      // permanece intacto en DB, nada que revertir. Si el estado real ya es
      // otro (contratada/cancelada/inexistente) se refresca el listado.
      alert(result.message)
      if (result.reload) await load()
      return
    }
    const data = result.data
    await load({ afterAction: true })
    // already_contracted=true (reintento/doble clic detectado por la propia
    // RPC) no trae receipt_folio — no es un error, es el resultado idempotente
    // esperado; no hay nada nuevo que descargar.
    if (!data.already_contracted && data.receipt_folio) {
      const { data: recRow } = await supabase.from('quotes').select('*').eq('folio', data.receipt_folio).single()
      if (recRow) await downloadPdf(recRow) // primera vez que existe este recibo
    }
  }

  // Fase 6.6B — cancelar una contratación. DB (cancel_quote_contract) es la
  // única autoridad transaccional: primero su commit, después — solo si tuvo
  // éxito — se intenta limpiar Calendar, de forma best-effort e
  // individual por servicio (nunca Promise.all: un evento que falle no debe
  // impedir intentar los demás).
  async function cancelContract(src) {
    const ok = window.confirm(
      `¿Cancelar la contratación de ${src.folio}?\n\n` +
      `Se cancelará su recibo asociado y los servicios pendientes, agendados o confirmados vinculados a esta cotización ` +
      `(los ya realizados no se modifican). El historial (cotización, recibo y servicios) se conserva — solo cambia su estado.\n\n` +
      `Esta acción no se puede deshacer.`
    )
    if (!ok) return
    const reasonInput = window.prompt('Motivo de la cancelación (opcional):', '')
    const reason = reasonInput && reasonInput.trim() ? reasonInput.trim() : null

    setCancellingId(src.id)
    const { data, error } = await supabase.rpc('cancel_quote_contract', { p_quote_id: src.id, p_reason: reason })
    setCancellingId(null)
    if (error) {
      // Fallo de RPC: cancelación NO confirmada — no se toca Calendar, el
      // estado contratado anterior permanece intacto.
      alert('No se pudo cancelar la contratación: ' + error.message)
      return
    }
    await load({ afterAction: true })
    if (data.already_cancelled) return

    const affected = (data.affected_services || []).filter((s) => s.google_event_id)
    if (affected.length) {
      const { data: { session } } = await supabase.auth.getSession()
      const failures = []
      for (const s of affected) {
        try {
          const res = await fetch('/api/services/cancel-calendar-event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
            body: JSON.stringify({ serviceId: s.id }),
          })
          if (!res.ok) failures.push(s.id)
        } catch (e) {
          failures.push(s.id)
        }
      }
      if (failures.length) {
        alert('Contratación cancelada correctamente, pero uno o más eventos de Google Calendar no pudieron eliminarse. Puedes reintentar la limpieza desde el detalle del servicio («Reintentar limpieza de Calendar»).')
      }
    }
  }

  async function deleteRecord(rec) {
    // Fase 6.5.1 — defensa en profundidad: no basta con ocultar el botón en
    // la UI. Cualquier llamada a esta función (accidental, futura, o desde
    // una fila que el render todavía no contemplara) se aborta aquí mismo,
    // antes de tocar DB o Storage, si el registro es historial contractual.
    if (!canDeleteQuote(rec)) {
      alert('Esta cotización no puede eliminarse: forma parte del historial contractual (contratada, cancelada, o es un recibo). Para revertir una contratación, usa "Cancelar Contratación" cuando esté disponible.')
      return
    }
    const isReceipt = rec.status === 'recibo'
    const tipo = isReceipt ? 'el recibo' : 'la cotización'
    const linked = isReceipt ? [] : (receiptsByFolio[rec.folio] || [])
    const extra = linked.length ? `\n\nTambién se eliminará su recibo asociado (${linked.map((r) => r.folio).join(', ')}).` : ''
    const ok = window.confirm(
      `¿Seguro que deseas eliminar ${tipo} ${rec.folio}?${extra}\n\nEsta acción no se puede deshacer: una vez borrado no podrás recuperarlo.`
    )
    if (!ok) return
    // H4-1 — el DELETE debe CONFIRMAR la fila eliminada. Si la política de
    // congelación (quotes_delete_lock) lo bloquea (p. ej. la cotización fue
    // contratada desde otra sesión), PostgREST responde SIN error y con 0
    // filas. Ante error, respuesta ausente/inesperada o 0 filas se corta aquí:
    // ni recibo ni Storage se tocan, y no se afirma que algo se eliminó.
    const res = await supabase.from('quotes').delete().eq('id', rec.id).select('id')
    if (res && res.error) { alert('No se pudo eliminar: ' + res.error.message); return }
    const deleted = res ? res.data : null
    if (Array.isArray(deleted) && deleted.length === 0) {
      alert('No se eliminó nada: el registro pudo cambiar (por ejemplo, fue contratado o eliminado desde otra sesión). Se actualiza el listado; revisa su estado actual.')
      await load()
      return
    }
    if (!Array.isArray(deleted) || deleted.length !== 1 || !deleted[0] || deleted[0].id !== rec.id) {
      alert('No se pudo confirmar la eliminación: el servidor respondió de forma inesperada. No se borró ningún archivo asociado. Se actualiza el listado; revisa el estado actual del registro.')
      await load()
      return
    }
    // Eliminación en cascada: primero la cotización (si falla, el recibo no
    // queda huérfano) y después su recibo asociado.
    if (!isReceipt) {
      const { error: recError } = await supabase.from('quotes').delete().eq('status', 'recibo').eq('related_folio', rec.folio)
      if (recError) alert('La cotización se eliminó, pero no se pudo eliminar su recibo: ' + recError.message)
    }
    // Fase 6.5 / 6.5.1 — limpia los objetos privados conocidos de ESTA
    // cotización (logo histórico y PDF persistido) para no dejarlos huérfanos
    // en Storage para siempre. El guard de arriba ya garantiza que nunca se
    // llega aquí con una contratada/cancelada/recibo — esta limpieza es,
    // por diseño, exclusiva de la eliminación física precontrato. Un fallo
    // aquí no revierte ni bloquea el borrado, que ya se completó.
    const removed = await removePaths([getHistoricalLogoPath(rec.id), getQuotePdfPath(rec.id)], { allowedPrefix: `quotes/${rec.id}/` })
    // Fase 6.7C-1 — además, los PDFs/logos de revisión de ESTA cotización
    // (quotes/{id}/revisions/*), que ya no se pueden nombrar de antemano.
    const removedRevisions = await removeQuoteRevisionFiles(rec.id)
    // Migración 2 — Storage responde éxito con lista vacía cuando una política impide
    // borrar, así que `ok` viene VERIFICADO por rutas (lib/storageVerifiedRemove.js).
    // La cotización ya está eliminada: si la limpieza quedó incompleta solo se avisa
    // como PENDIENTE (sin sugerir repetir la eliminación ni revertir nada).
    const cleanupResults = [removed, removedRevisions]
    if (!cleanupResults.every((r) => r && r.ok === true)) {
      // Solo el folio y estados de un vocabulario fijo: nunca rutas, mensajes de error crudos ni datos de sesión.
      console.warn('Limpieza de Storage pendiente', rec.folio, cleanupResults.map((r) => (r && typeof r.status === 'string' ? r.status : 'sin_resultado')).join(','))
      alert(describeCleanupPending(rec.folio, cleanupResults))
    }
    load({ afterAction: true })
  }

  // Cada clave de acción que decide lib/historialView.js se conecta aquí con el manejador de SIEMPRE (arriba, sin cambios de reglas).
  function runAction(key, q, serviceView) {
    if (key === 'pdf') return downloadPdf(q)
    if (key === 'email') return sendByEmail(q)
    if (key === 'whatsapp') return sendByWhatsapp(q)
    if (key === 'link') return setManagingId(q.id)
    if (key === 'edit') return router.push(`/cotizar?edit=${q.id}`)
    if (key === 'accept') return contractQuote(q)
    if (key === 'cancel') return cancelContract(q)
    if (key === 'delete') return deleteRecord(q)
    if (key === 'service' && serviceView) return router.push(serviceActionHref(serviceView.action))
    return undefined
  }
  const ACTION_ICON = { accept: 'check', service: 'calendar' }

  // Una fila del historial. Las cotizaciones son el registro principal; su recibo (si existe) se dibuja como fila hija (registro asociado, no
  // una cotización más). Tres estados SEPARADOS: comercial, del servicio y del enlace del PDF. Una acción principal + «⋯» con las demás.
  function renderRow(q, { children = [], isOpen = false, isChild = false } = {}) {
    const isReceipt = q.status === 'recibo'
    const services = isReceipt ? [] : (servicesByQuoteId.get(q.id) || [])
    const serviceView = isReceipt ? null : resolveQuoteServiceView(q, services)
    const manageLink = canManageLink(q) && (linkCap.state === 'enabled' || linkCap.state === 'error')
    const { primary, secondary } = recordActions({ q, isChild, serviceView, caps: { manageLink } })
    const contracting = contractingId === q.id
    const cancelling = cancellingId === q.id
    const working = contracting || cancelling
    const primaryLabel = primary && primary.key === 'accept' && contracting ? 'Registrando…' : primary && primary.label
    const isAccepted = !isReceipt && stateOf(q) === 'contratado'
    const items = secondary.map((a) => {
      if (a.children) {
        return { key: a.key, label: a.label, onEnter: () => prefetchSendLink(q), children: a.children.map((c) => ({ key: c.key, label: c.label, onSelect: () => runAction(c.key, q, serviceView) })) }
      }
      return { key: a.key, label: a.key === 'cancel' && cancelling ? 'Cancelando…' : a.label, danger: a.danger, disabled: a.key === 'cancel' && cancelling, onSelect: () => runAction(a.key, q, serviceView) }
    })
    const clientShown = shortName(q.client_name)
    const clientCut = clientShown !== (q.client_name || '')
    const typeLabel = !isReceipt && TYPE_LABEL[q.quote_type] ? TYPE_LABEL[q.quote_type] : ''
    // Nivel intermedio de la tarjeta: tipo de cotización; un recibo se identifica como tal y nombra la cotización a la que pertenece (related_folio).
    const typeLine = isReceipt ? (q.related_folio ? `Recibo de ${q.related_folio}` : 'Recibo') : typeLabel
    const sub = [typeLine, q.client_phone].filter(Boolean).join(' · ')
    const commercial = COMMERCIAL[stateOf(q)]
    const serviceChips = []
    if (serviceView) {
      serviceView.badges.slice(1).forEach((b) => serviceChips.push({ text: `Servicio: ${b.text}`, tone: b.tone }))
      if (serviceView.action.kind === 'view_many') serviceChips.push({ text: `${services.length} servicios`, tone: 'neutral' })
    }
    const ls = linkStates[q.id]
    const showLink = !isReceipt && linkCap.state === 'enabled' && canManageLink(q)
    return (
      <div className={`dn-h-row${isChild ? ' dn-h-child' : ''}`} key={q.id} data-testid="hist-row" data-folio={q.folio}>
        <div className="dn-h-f">
          {isChild ? (
            <span className="dn-h-toggle dn-h-ph" aria-hidden="true" />
          ) : children.length ? (
            <button
              type="button" className="dn-h-toggle" aria-expanded={isOpen}
              aria-label={`${isOpen ? 'Ocultar' : 'Ver'} recibo de ${q.folio}`} title={isOpen ? 'Ocultar recibo' : 'Ver recibo'}
              onClick={() => setExpanded((e) => ({ ...e, [q.id]: !e[q.id] }))}
            ><DonnieIcon name="down" /></button>
          ) : (
            <span className="dn-h-toggle dn-h-ph" aria-hidden="true" />
          )}
          <div className="dn-h-ell">
            <div className="dn-h-folio" title={q.folio}>{isChild && <DonnieIcon name="receipt" />}{q.folio}</div>
            <div className="dn-h-date">{new Date(q.created_at).toLocaleDateString('es-MX')}</div>
          </div>
        </div>
        <div className="dn-h-c">
          <div className="dn-h-cwrap">
            {/* Máximo 25 caracteres en pantalla (con la elipsis); el nombre completo queda en el dato y en un aviso al pasar el mouse o enfocar. */}
            <div className="dn-h-client" data-full={q.client_name} {...(clientCut ? { tabIndex: 0, 'aria-describedby': `nm-${q.id}` } : {})}>{clientShown}</div>
            {clientCut && <span role="tooltip" id={`nm-${q.id}`} className="dn-h-ctip">{q.client_name}</span>}
          </div>
          <div className="dn-h-sub" title={sub}>{sub}</div>
          {typeLine && <div className="dn-h-type">{typeLine}</div>}
        </div>
        <div className="dn-h-total">{fmt(q.total)}</div>
        <div className="dn-h-states">
          {isReceipt ? (
            <span className={`dn-h-chip dn-t-${q.receipt_status === 'cancelado' ? 'can' : 'rec'}`}>{q.receipt_status === 'cancelado' ? 'Recibo cancelado' : 'Recibo'}</span>
          ) : (
            <>
              <span className={`dn-h-chip dn-t-${commercial.tone}`} data-state={stateOf(q)} title={commercial.hint ? `Estado comercial: ${commercial.hint}` : 'Estado comercial'}>{commercial.label}</span>
              {serviceChips.map((c) => <span key={c.text} className={`dn-h-chip dn-t-${c.tone}`} title="Estado del servicio">{c.text}</span>)}
              {showLink && (
                !ls || !ls.ok || !LINK_CHIP[ls.state]
                  ? <span className="dn-h-chip dn-t-neutral" title="El estado del enlace de su PDF no se ha consultado: ábrelo con «Gestionar enlace»." data-testid="link-badge">Enlace no consultado</span>
                  : <span className={`dn-h-chip dn-t-${LINK_CHIP[ls.state][0]}`} title={`${ls.text} (Consultado al cargar la lista; puede haber cambiado. Al descargar o abrir «Gestionar enlace» se consulta de nuevo.)`} data-testid="link-badge">{LINK_CHIP[ls.state][1]}</span>
              )}
            </>
          )}
        </div>
        <div className="dn-h-acts">
          {primary && (primary.key === 'accept' ? (
            // Aceptación manual: texto corto + aviso al pasar el mouse o enfocar (el motivo se explica en el tooltip; la función es la misma contractQuote)
            <span className="dn-h-tipwrap">
              <button
                type="button" className="dn-h-btn dn-h-primary" data-action="accept" aria-describedby={`tip-${q.id}`}
                disabled={working} onClick={() => runAction('accept', q, serviceView)}
              ><DonnieIcon name="check" />{primaryLabel}</button>
              <span role="tooltip" id={`tip-${q.id}`} className="dn-h-tip">El cliente aceptó esta cotización</span>
            </span>
          ) : (
            <button
              type="button" className={`dn-h-btn${primary.tone === 'primary' || primary.tone === 'accent' ? ' dn-h-primary' : ''}`}
              data-action={primary.key} disabled={working} onClick={() => runAction(primary.key, q, serviceView)}
            >{ACTION_ICON[primary.key] && <DonnieIcon name={ACTION_ICON[primary.key]} />}{primaryLabel}</button>
          ))}
          {isAccepted && <span className="dn-h-accepted" title={`Estado comercial: ${commercial.hint}`}>{commercial.label}</span>}
          {items.length > 0 && <ActionMenu label={`Más acciones de ${q.folio}`} title={q.folio} items={items} disabled={working} closeSignal={viewEpoch} />}
        </div>
      </div>
    )
  }

  const pager = pageWindow(curPage, totalPages)
  const mobilePages = pageWindow3(curPage, totalPages)

  return (
    <div className="dn-home dn-hist">
      <div className="dn-h-head">
        <div>
          <h1>Mis cotizaciones</h1>
          <p>Todas tus cotizaciones y recibos, en un solo lugar.</p>
        </div>
        <Link href="/cotizador/nueva" className="dn-h-btn dn-h-accent"><DonnieIcon name="plus" />Nueva cotización</Link>
      </div>

      <section className="dn-h-filters" aria-label="Filtros">
        <div className="dn-h-frow">
          <label className="dn-h-search">
            <span className="dn-sr">Buscar por nombre o folio</span>
            <DonnieIcon name="search" />
            <input value={searchText} onChange={(e) => changeSearch(e.target.value)} placeholder="Buscar por nombre o folio" />
          </label>
          <label className="dn-h-date-f">
            <span className="dn-sr">Filtrar por fecha</span>
            <input type="date" value={searchDate} onChange={(e) => changeDate(e.target.value)} />
          </label>
          {filtersActive && <button type="button" className="dn-h-link" onClick={clearFilters}>Limpiar filtros</button>}
        </div>
        <div className="dn-h-chips" role="group" aria-label="Tipo de registro">
          {TYPE_FILTERS.map((f) => (
            <button key={f.value} type="button" className="dn-h-fchip" aria-pressed={typeFilter === f.value} data-filter-type={f.value} onClick={() => changeType(f.value)}>
              {f.label} <span className="dn-h-n">{typeCounts[f.value]}</span>
            </button>
          ))}
        </div>
        <div className="dn-h-chips" role="group" aria-label="Estado de la cotización">
          {STATE_FILTERS.map((f) => (
            <button key={f.value} type="button" className="dn-h-fchip" aria-pressed={stateFilter === f.value} data-filter-state={f.value} onClick={() => changeState(f.value)}>
              {f.label} <span className="dn-h-n">{stateCounts[f.value]}</span>
            </button>
          ))}
        </div>
      </section>

      {truncated && (
        <p className="dn-h-notice" role="status" data-testid="hist-truncated">
          Se cargaron los {quotes.length} registros más recientes de {quotesTotal}. La búsqueda, los filtros y los contadores consideran solo esos {quotes.length}; los {quotesTotal - quotes.length} más antiguos no aparecen en esta lista.
        </p>
      )}

      <div ref={listTopRef} className="dn-h-top" />
      {!filtered.length ? (
        <div className="dn-h-empty" data-testid="hist-empty">
          <b>{quotes.length ? 'No hay resultados con esos filtros.' : 'Todavía no has generado ninguna cotización.'}</b>
          {quotes.length ? (
            <button type="button" className="dn-h-btn" onClick={clearFilters}>Limpiar filtros</button>
          ) : (
            <Link href="/cotizador/nueva" className="dn-h-btn dn-h-primary"><DonnieIcon name="plus" />Nueva cotización</Link>
          )}
        </div>
      ) : (
        <>
          <section className="dn-h-list" aria-label="Cotizaciones y recibos">
            {pageItems.map((q) => {
              const children = q.status === 'recibo' ? [] : (receiptsByFolio[q.folio] || [])
              const isOpen = !!expanded[q.id] || typeFilter === 'recibo'
              return (
                <div className="dn-h-group" key={q.id}>
                  {renderRow(q, { children, isOpen })}
                  {children.length > 0 && isOpen && children.map((r) => renderRow(r, { isChild: true }))}
                </div>
              )
            })}
          </section>

          <nav className="dn-h-pager" aria-label="Paginación">
            <div className="dn-h-info" aria-live="polite" data-testid="hist-info">
              Mostrando <b>{range.from}–{range.to}</b> de <b>{filtered.length}</b> resultado{filtered.length === 1 ? '' : 's'}{filtersActive ? ' con los filtros actuales' : ''} · página {curPage} de {totalPages}
            </div>
            <div className="dn-h-ctrl">
              <label className="dn-h-size">
                Por página
                <select value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))}>
                  {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <button type="button" className="dn-h-pg dn-h-edge" disabled={curPage <= 1} aria-label="Primera página" title="Primera página" onClick={() => goToPage(1)}><DonnieIcon name="first" /></button>
              <button type="button" className="dn-h-pg" disabled={curPage <= 1} onClick={() => goToPage(curPage - 1)}><DonnieIcon name="left" /><span className="dn-h-pgtxt">Anterior</span></button>
              {pager.map((n, i) => (n === '…'
                ? <span key={`gap${i}`} className="dn-h-gap" aria-hidden="true">…</span>
                : <button key={n} type="button" className={`dn-h-pg dn-h-num${mobilePages.includes(n) ? ' dn-h-m' : ''}`} aria-current={n === curPage ? 'page' : undefined} aria-label={`Página ${n}`} onClick={() => goToPage(n)}>{n}</button>
              ))}
              <button type="button" className="dn-h-pg" disabled={curPage >= totalPages} onClick={() => goToPage(curPage + 1)}><span className="dn-h-pgtxt">Siguiente</span><DonnieIcon name="right" /></button>
              <button type="button" className="dn-h-pg dn-h-edge" disabled={curPage >= totalPages} aria-label="Última página" title="Última página" onClick={() => goToPage(totalPages)}><DonnieIcon name="last" /></button>
            </div>
          </nav>
        </>
      )}

      {(() => {
        const mq = managingId ? quotes.find((x) => x.id === managingId) : null
        return mq ? <LinkManager key={mq.id} rec={mq} onClose={() => setManagingId(null)} onChanged={() => load({ afterAction: true })} /> : null
      })()}
    </div>
  )
}
