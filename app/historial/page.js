// app/historial/page.js
'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { fmt, isValidEmail, isValidPhone10 } from '@/lib/calc'
import { fillTemplate } from '@/lib/templates'
import { triggerPdfDownload, resolveQuoteDownload } from '@/lib/pdf'
import { contractQuoteFlow } from '@/lib/quoteContracting'
import { getHistoricalLogoPath, removePaths } from '@/lib/quoteLogo'
import { getQuotePdfPath, removeQuoteRevisionFiles } from '@/lib/quotePdfStorage'
import { isContracted, isCancelled, canDeleteQuote, canContractQuote, canCancelContract } from '@/lib/quoteLifecycle'
import SendMenu from '@/components/SendMenu'
import { SERVICE_STATUS_LABEL, SERVICE_STATUS_BADGE } from '@/lib/serviceStatus'

const PAGE_SIZE = 20

export default function HistorialPage() {
  const [quotes, setQuotes] = useState([])
  const [services, setServices] = useState([]) // para saber qué cotizaciones ya tienen servicio
  const [config, setConfig] = useState(null)
  const [searchText, setSearchText] = useState('')
  const [searchDate, setSearchDate] = useState('')
  const [typeFilter, setTypeFilter] = useState('all') // all | cotizacion | recibo
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState({}) // id de cotización -> true si su recibo está desplegado
  const [contractingId, setContractingId] = useState(null) // id de la quote que se está contratando (evita doble clic)
  const [cancellingId, setCancellingId] = useState(null) // id de la quote que se está cancelando
  const router = useRouter()

  async function load() {
    const [{ data: q }, { data: cfg }, { data: svc }] = await Promise.all([
      supabase.from('quotes').select('*').order('created_at', { ascending: false }),
      supabase.from('app_config').select('*').eq('id', 1).single(),
      supabase.from('services').select('id, quote_id, status'),
    ])
    setQuotes(q || [])
    setConfig(cfg)
    setServices(svc || [])
  }
  useEffect(() => { load() }, [])
  useEffect(() => { setPage(1) }, [searchText, searchDate, typeFilter])

  const serviceByQuoteId = useMemo(() => {
    const map = new Map()
    services.forEach((s) => map.set(s.quote_id, s))
    return map
  }, [services])

  // Un recibo se relaciona con su cotización por `related_folio` (relación que
  // ya existía). Se muestra como hijo de su cotización; si por datos antiguos
  // no tiene cotización padre, se conserva como registro independiente para
  // no perderlo.
  const receiptsByFolio = useMemo(() => {
    const cotFolios = new Set(quotes.filter((q) => q.status !== 'recibo').map((q) => q.folio))
    const map = {}
    quotes.forEach((q) => {
      if (q.status === 'recibo' && q.related_folio && cotFolios.has(q.related_folio)) {
        ;(map[q.related_folio] ||= []).push(q)
      }
    })
    return map
  }, [quotes])

  const filtered = useMemo(() => {
    const text = searchText.trim().toLowerCase()
    const matches = (q) => {
      if (text) {
        const haystack = `${q.client_name || ''} ${q.folio || ''}`.toLowerCase()
        if (!haystack.includes(text)) return false
      }
      if (searchDate) {
        const qDate = new Date(q.created_at).toISOString().slice(0, 10)
        if (qDate !== searchDate) return false
      }
      return true
    }
    // Lista principal: cotizaciones (con su recibo dentro) + recibos sin padre.
    return quotes.filter((q) => {
      const isReceipt = q.status === 'recibo'
      if (isReceipt && q.related_folio && receiptsByFolio[q.related_folio]) return false // va dentro de su cotización
      const children = isReceipt ? [] : (receiptsByFolio[q.folio] || [])
      if (typeFilter === 'cotizacion' && isReceipt) return false
      if (typeFilter === 'recibo' && !isReceipt && !children.length) return false
      return matches(q) || children.some(matches)
    })
  }, [quotes, receiptsByFolio, searchText, searchDate, typeFilter])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  if (!config) return <div>Cargando…</div>

  async function downloadPdf(rec) {
    const result = await resolveQuoteDownload(rec, config)
    if (!result.ok) { alert(result.message); return }
    triggerPdfDownload(result.blob, result.filename)
  }

  // ---------- Correo: manual (adjuntar tú mismo). Ya NO descarga el PDF de
  // nuevo — ese archivo ya se descargó cuando se creó el registro (o al
  // marcarlo como contratado); aquí solo se abre el correo con la plantilla
  // lista, para no acumular descargas repetidas. Si necesitas el PDF otra
  // vez, está el botón "PDF" a un lado. Abrimos el correo de inmediato, de
  // forma síncrona: los celulares solo permiten abrir apps externas
  // mientras dura el "gesto" del clic. ----------
  function sendByEmail(rec) {
    if (!isValidEmail(rec.client_email)) {
      alert('Este cliente no cuenta con un correo capturado (o no tiene un formato válido). Edita el registro para agregarlo antes de enviarlo por correo.')
      return
    }
    const isReceipt = rec.status === 'recibo'
    const subjectTpl = isReceipt ? config.receipt_email_subject_template : config.email_subject_template
    const bodyTpl = isReceipt ? config.receipt_email_body_template : config.email_body_template
    const subject = fillTemplate(subjectTpl, rec, config)
    const body = fillTemplate(bodyTpl, rec, config)
    window.location.href = `mailto:${rec.client_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }

  // ---------- WhatsApp: mismo principio, ya sin descarga automática. ----------
  function sendByWhatsapp(rec) {
    if (!isValidPhone10(rec.client_phone)) {
      alert('Este cliente no cuenta con un teléfono capturado a 10 dígitos. Edita el registro para agregarlo antes de enviarlo por WhatsApp.')
      return
    }
    const digits = rec.client_phone.replace(/\D/g, '')
    const isReceipt = rec.status === 'recibo'
    const waTpl = isReceipt ? config.receipt_whatsapp_template : config.whatsapp_template
    const text = fillTemplate(waTpl, rec, config)
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
    await load()
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
    await load()
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
        alert('Contratación cancelada correctamente, pero uno o más eventos de Google Calendar no pudieron eliminarse.')
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
    const { error } = await supabase.from('quotes').delete().eq('id', rec.id)
    if (error) { alert('No se pudo eliminar: ' + error.message); return }
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
    const removed = await removePaths([getHistoricalLogoPath(rec.id), getQuotePdfPath(rec.id)])
    // Fase 6.7C-1 — además, los PDFs/logos de revisión de ESTA cotización
    // (quotes/{id}/revisions/*), que ya no se pueden nombrar de antemano.
    const removedRevisions = await removeQuoteRevisionFiles(rec.id)
    if (!removed.ok || !removedRevisions.ok) alert('Se eliminó correctamente, pero no fue posible limpiar sus archivos asociados en Storage (quedaron huérfanos, sin afectar el resto del sistema).')
    load()
  }

  // Una fila del historial. Las cotizaciones son el registro principal; su
  // recibo (si existe) se dibuja como fila hija con solo PDF y Enviar.
  function renderRow(q, { children = [], isOpen = false, isChild = false } = {}) {
    const isReceipt = q.status === 'recibo'
    const service = serviceByQuoteId.get(q.id)
    const cellStatus = service?.status || 'pendiente_agendar'
    return (
      <div className={`hist-row hist-row-fixed${isChild ? ' hist-child' : ''}`} key={q.id}>
        <div className="hist-folio">
          {isChild ? (
            <span className="hist-branch" aria-hidden="true">└</span>
          ) : children.length ? (
            <button
              className="hist-toggle"
              aria-expanded={isOpen}
              title={isOpen ? 'Ocultar recibo' : 'Ver recibo'}
              onClick={() => setExpanded((e) => ({ ...e, [q.id]: !e[q.id] }))}
            >{isOpen ? '▲' : '▼'}</button>
          ) : (
            <span className="hist-toggle-spacer" />
          )}
          <div className="ell-wrap">
            <div className="ell" title={q.folio} style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{q.folio}</div>
            <div className="muted ell">{new Date(q.created_at).toLocaleDateString('es-MX')}</div>
          </div>
        </div>
        <div>
          <div className="ell" title={q.client_name}>{q.client_name}</div>
          <div className="muted ell" title={q.client_phone}>{q.client_phone}</div>
        </div>
        <div className="ell" style={{ fontFamily: 'var(--mono)' }}>{fmt(q.total)}</div>
        <div>
          {isReceipt ? (
            <span className="badge rec">{q.receipt_status === 'cancelado' ? 'RECIBO · CANCELADO' : 'RECIBO'}</span>
          ) : isCancelled(q) ? (
            <span className="badge can">CANCELADO</span>
          ) : isContracted(q) ? (
            <span className={`badge ${SERVICE_STATUS_BADGE[cellStatus]}`}>{SERVICE_STATUS_LABEL[cellStatus]}</span>
          ) : (
            <span className="badge cot">COTIZACIÓN</span>
          )}
        </div>
        <div className="hist-actions">
          <button className="btn ghost small" onClick={() => downloadPdf(q)}>PDF</button>

          <SendMenu onEmail={() => sendByEmail(q)} onWhatsapp={() => sendByWhatsapp(q)} />

          {!isReceipt && canContractQuote(q) && (
            <button className="btn ghost small" onClick={() => router.push(`/cotizar?edit=${q.id}`)}>Editar</button>
          )}
          {!isReceipt && canContractQuote(q) && (
            <button className="btn teal small" disabled={contractingId === q.id} onClick={() => contractQuote(q)}>
              {contractingId === q.id ? 'Contratando…' : 'Marcar contratado'}
            </button>
          )}
          {!isReceipt && canCancelContract(q) && (
            <button className="btn ghost small" disabled={cancellingId === q.id} onClick={() => cancelContract(q)}>
              {cancellingId === q.id ? 'Cancelando…' : 'Cancelar contratación'}
            </button>
          )}
          {!isReceipt && isContracted(q) && !service && (
            <button className="btn teal small" onClick={() => router.push(`/servicios/nuevo?quoteId=${q.id}`)}>Agendar servicio</button>
          )}
          {!isReceipt && (isContracted(q) || isCancelled(q)) && service && (
            <button className="btn ghost small" onClick={() => router.push(`/servicios/${service.id}`)}>Ver servicio</button>
          )}
          {!isChild && canDeleteQuote(q) && (
            <button className="iconbtn" title="Eliminar" onClick={() => deleteRecord(q)}>✕</button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      <h2 className="pagetitle">Historial</h2>
      <div className="pagesub">Todas tus cotizaciones y recibos.</div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="hist-search-grid">
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
            {pageItems.map((q) => {
              const children = q.status === 'recibo' ? [] : (receiptsByFolio[q.folio] || [])
              const isOpen = !!expanded[q.id] || typeFilter === 'recibo'
              return (
                <div key={q.id}>
                  {renderRow(q, { children, isOpen })}
                  {children.length > 0 && isOpen && children.map((r) => renderRow(r, { isChild: true }))}
                </div>
              )
            })}
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
