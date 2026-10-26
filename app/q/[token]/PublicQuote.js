// app/q/[token]/PublicQuote.js — pantalla pública de una cotización (Fase 6.7 / bloque 6). Sin sesión.
// Usa SOLO la API existente (/api/public/quotes/{token}[/accept|/logo]); no repite reglas de negocio del servidor.
// Privacidad: el token, el nonce y el nombre declarado viven solo en memoria de esta página: nada en localStorage/sessionStorage/
// cookies, nada en console, nada en mensajes de error; sin analítica ni recursos de terceros; todo el texto se pinta como texto.
'use client'
import { useEffect, useReducer, useRef, useState } from 'react'
import {
  ACCEPT_TIMEOUT_MS, CONSENT_TEXT_V1, CONSENT_VERSION, ERROR_COOLDOWN_S, GET_TIMEOUT_MS, REVIEWED_TEXT, STALE_LINK_NOTICE,
  UNKNOWN_CHECK_DELAYS_MS, canSubmit, fieldMessage, flagActive, formatDate, formatDateTime, formatMoney, formatQty, isStaleHint,
  normalizeAccept, normalizeQuote, sanitizeText,
} from '@/lib/publicQuoteView'
import s from './public-quote.module.css'

// ---------------------------------------------------------------------------
// Red: una sola función. Sin cookies, sin Referer, sin caché, con tiempo límite. Nunca lanza.
// ---------------------------------------------------------------------------
async function fetchJson(url, init, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
    let body = null
    try { body = await r.json() } catch { body = null }
    return { ok: true, status: r.status, body }
  } catch {
    return { ok: false, status: 0, body: null }
  } finally {
    clearTimeout(timer)
  }
}

const apiUrl = (token, suffix = '') => `/api/public/quotes/${encodeURIComponent(token)}${suffix}`
const getQuote = async (token) => normalizeQuote(await fetchJson(apiUrl(token), { method: 'GET' }, GET_TIMEOUT_MS))
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const INITIAL = {
  view: { kind: 'loading' },
  name: '',
  consent: null,   // { revision, value }: solo vale para esa revisión
  reviewed: null,  // { revision, value }: «He revisado la versión vigente»
  changed: false,  // la revisión cambió durante esta visita: hay que revisar expresamente la nueva
  notice: null,    // { tone: 'info' | 'warn' | 'error' | 'ok', text }
  fieldError: '',
  busy: false,
  unknown: 'idle', // 'idle' | 'checking' | 'unconfirmed'
  retryAt: 0,
  logoFailed: false,
  done: null,      // aceptación confirmada en esta visita: { already, matches, acceptedAt, revisionCode, name }
}

function reducer(state, a) {
  switch (a.type) {
    case 'loaded': {
      const v = a.view
      // Un fallo al refrescar no destruye una cotización abierta que ya se estaba mostrando.
      if ((v.kind === 'error' || v.kind === 'ratelimited') && state.view.kind === 'open') {
        return { ...state, notice: { tone: 'warn', text: v.kind === 'ratelimited' ? 'Demasiadas consultas. Espera unos segundos e inténtalo de nuevo.' : 'No pudimos actualizar la información. Inténtalo de nuevo en unos segundos.' }, retryAt: v.kind === 'ratelimited' ? a.now + v.retryAfter * 1000 : a.now + ERROR_COOLDOWN_S * 1000 }
      }
      const revisionChanged = v.kind === 'open' && state.view.kind === 'open' && state.view.revision !== v.revision
      return {
        ...state,
        view: v,
        changed: state.changed || revisionChanged,
        logoFailed: revisionChanged ? false : state.logoFailed,
        retryAt: v.kind === 'ratelimited' ? a.now + v.retryAfter * 1000 : (v.kind === 'error' ? a.now + ERROR_COOLDOWN_S * 1000 : 0),
      }
    }
    case 'name': return { ...state, name: a.value.slice(0, 400), fieldError: '' }
    case 'consent': return { ...state, consent: { revision: a.revision, value: a.value }, fieldError: '' }
    case 'reviewed': return { ...state, reviewed: { revision: a.revision, value: a.value } }
    case 'busy': return { ...state, busy: a.value }
    case 'notice': return { ...state, notice: a.notice }
    case 'fieldError': return { ...state, fieldError: a.value }
    case 'unknown': return { ...state, unknown: a.value }
    case 'retryAt': return { ...state, retryAt: a.value }
    case 'logoFailed': return { ...state, logoFailed: true }
    case 'done': return { ...state, done: a.done, notice: null, fieldError: '' }
    default: return state
  }
}

// ---------------------------------------------------------------------------
// Presentación
// ---------------------------------------------------------------------------
function Brand({ name, token, showLogo, onLogoError }) {
  const text = name || 'Cotización'
  return (
    <header className={s.brand}>
      {showLogo ? (
        // eslint-disable-next-line @next/next/no-img-element -- logo servido por la propia API (mismo origen, sin optimizador ni terceros)
        <img className={s.logo} src={apiUrl(token, '/logo')} alt={name ? `Logotipo de ${name}` : 'Logotipo de la empresa'} referrerPolicy="no-referrer" onError={onLogoError} />
      ) : null}
      <span className={showLogo ? s.brandNameSub : s.brandName}>{text}</span>
    </header>
  )
}

function Notice({ notice }) {
  if (!notice) return null
  const cls = notice.tone === 'error' ? s.noticeError : notice.tone === 'warn' ? s.noticeWarn : notice.tone === 'ok' ? s.noticeOk : s.noticeInfo
  return <div className={`${s.notice} ${cls}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</div>
}

function Row({ label, children }) {
  if (children === '' || children === null || children === undefined) return null
  return <div className={s.kv}><dt>{label}</dt><dd>{children}</dd></div>
}

function QuoteDoc({ doc, view }) {
  const discountLabel = doc.discountType === 'percent' && doc.discountValue !== null ? `Descuento (${doc.discountValue}%)` : 'Descuento'
  const installTxt = doc.installTimeValue !== null && doc.installTimeUnit ? `${formatQty(doc.installTimeValue)} ${doc.installTimeUnit}` : ''
  return (
    <>
      <section className={s.panel} aria-labelledby="q-resumen">
        <h2 id="q-resumen" className={s.h2}>Cotización {doc.folio}</h2>
        <dl className={s.kvgrid}>
          <Row label="Cliente">{doc.clientName}</Row>
          <Row label="Fecha">{formatDate(doc.createdAt)}</Row>
          <Row label="Vigencia">{view.validUntil ? `Hasta el ${formatDate(view.validUntil)}` : ''}</Row>
          <Row label="Versión">{view.revisionCode}</Row>
          <Row label="Tiempo estimado">{installTxt}</Row>
          <Row label="Dirección del servicio">{doc.serviceAddress}</Row>
        </dl>
      </section>

      <section className={s.panel} aria-labelledby="q-conceptos">
        <h2 id="q-conceptos" className={s.h2}>Conceptos</h2>
        {doc.items.length === 0 ? <p className={s.muted}>Esta cotización no tiene conceptos para mostrar.</p> : (
          <table className={s.table}>
            <thead><tr><th scope="col">Concepto</th><th scope="col" className={s.num}>Cant.</th><th scope="col" className={s.num}>Precio</th><th scope="col" className={s.num}>Importe</th></tr></thead>
            <tbody>
              {doc.items.map((it, i) => (
                <tr key={i}>
                  <td data-label="Concepto">{it.name}{it.unit ? <span className={s.unit}> · {it.unit}</span> : null}</td>
                  <td data-label="Cant." className={s.num}>{formatQty(it.qty)}</td>
                  <td data-label="Precio" className={s.num}>{formatMoney(it.price)}</td>
                  <td data-label="Importe" className={s.num}>{formatMoney(it.subtotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <dl className={s.totals}>
          <div><dt>Subtotal</dt><dd>{formatMoney(doc.subtotal)}</dd></div>
          {doc.discount ? <div><dt>{discountLabel}</dt><dd>− {formatMoney(doc.discount)}</dd></div> : null}
          {doc.applyIva ? <div><dt>{doc.ivaRate !== null ? `IVA (${doc.ivaRate}%)` : 'IVA'}</dt><dd>{formatMoney(doc.iva)}</dd></div> : null}
          <div className={s.grand}><dt>Total</dt><dd>{formatMoney(doc.total)}</dd></div>
        </dl>
      </section>

      {doc.notes ? (
        <section className={s.panel} aria-labelledby="q-notas">
          <h2 id="q-notas" className={s.h2}>Notas</h2>
          <p className={s.pre}>{doc.notes}</p>
        </section>
      ) : null}

      {doc.company.terms ? (
        <section className={s.panel} aria-labelledby="q-terminos">
          <h2 id="q-terminos" className={s.h2}>Términos y condiciones</h2>
          <p className={s.pre}>{doc.company.terms}</p>
        </section>
      ) : null}

      <section className={s.panel} aria-labelledby="q-empresa">
        <h2 id="q-empresa" className={s.h2}>{doc.company.name || 'Empresa'}</h2>
        <dl className={s.kvgrid}>
          <Row label="Teléfono">{doc.company.phone}</Row>
          <Row label="Correo">{doc.company.email}</Row>
          <Row label="Dirección">{doc.company.address}</Row>
          <Row label="Sitio web">{doc.company.website}</Row>
        </dl>
      </section>
    </>
  )
}

function StateCard({ title, children, tone }) {
  // Al mostrarse un estado (aceptada, vencida, error…) el foco pasa al título para que lectores de pantalla y teclado lo anuncien.
  const headingRef = useRef(null)
  useEffect(() => { if (headingRef.current) headingRef.current.focus() }, [])
  return (
    <section className={`${s.panel} ${s.stateCard} ${tone === 'ok' ? s.stateOk : ''}`}>
      <h1 ref={headingRef} className={s.h1} tabIndex={-1}>{title}</h1>
      {children}
    </section>
  )
}

function info(view) {
  const parts = []
  if (view.folio) parts.push(`Cotización ${view.folio}`)
  if (view.companyName) parts.push(view.companyName)
  return parts.length ? <p className={s.muted}>{parts.join(' · ')}</p> : null
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------
export default function PublicQuote({ token, hint }) {
  const [st, dispatch] = useReducer(reducer, INITIAL)
  const submitRef = useRef(false)  // bloqueo síncrono contra doble clic (antes de que React pinte el botón deshabilitado)
  const aliveRef = useRef(true)
  const [remaining, setRemaining] = useState(0)

  // Carga inicial: una sola consulta, sin reintentos automáticos.
  useEffect(() => {
    aliveRef.current = true
    ;(async () => {
      const v = await getQuote(token)
      if (aliveRef.current) dispatch({ type: 'loaded', view: v, now: Date.now() })
    })()
    return () => { aliveRef.current = false }
  }, [token])

  // Cuenta regresiva visible para 429 / errores (solo habilita el botón; no reintenta nada).
  useEffect(() => {
    if (!st.retryAt) return undefined
    const tick = () => {
      const left = Math.max(0, Math.ceil((st.retryAt - Date.now()) / 1000))
      setRemaining(left)
      if (left === 0) clearInterval(id)
    }
    const id = setInterval(tick, 500)
    const first = setTimeout(tick, 0)
    return () => { clearInterval(id); clearTimeout(first) }
  }, [st.retryAt])

  const view = st.view
  const open = view.kind === 'open' ? view : null
  const stale = !!open && isStaleHint(hint, open.revisionCode)
  const needsReview = !!open && (stale || st.changed)
  const consentOn = !!open && flagActive(st.consent, open.revision)
  const reviewedOn = !!open && flagActive(st.reviewed, open.revision)
  const submitOk = canSubmit({ view, name: st.name, consent: st.consent, reviewed: st.reviewed, needsReview, busy: st.busy || st.unknown === 'checking' })
  const cooling = st.retryAt > 0 && remaining > 0

  async function refresh() {
    const v = await getQuote(token)
    if (aliveRef.current) dispatch({ type: 'loaded', view: v, now: Date.now() })
    return v
  }

  async function reload() {
    dispatch({ type: 'notice', notice: null })
    await refresh()
  }

  // Tras un resultado no confirmado: SOLO se consulta el estado (GET), un número acotado de veces. Nunca se reenvía accept.
  async function confirmUnknown(manual) {
    dispatch({ type: 'unknown', value: 'checking' })
    dispatch({ type: 'notice', notice: { tone: 'info', text: 'No pudimos confirmar el resultado. Estamos verificando el estado de tu cotización…' } })
    const delays = manual ? [0] : UNKNOWN_CHECK_DELAYS_MS
    for (const d of delays) {
      if (d) await sleep(d)
      if (!aliveRef.current) return
      const v = await getQuote(token)
      if (!aliveRef.current) return
      if (v.kind === 'accepted') {
        dispatch({ type: 'loaded', view: v, now: Date.now() })
        dispatch({ type: 'done', done: { already: false, matches: true, confirmed: true, acceptedAt: v.acceptedAt, revisionCode: v.revisionCode, name: v.acceptedByName } })
        dispatch({ type: 'unknown', value: 'idle' })
        return
      }
      if (v.kind !== 'open' && v.kind !== 'error' && v.kind !== 'ratelimited') {
        dispatch({ type: 'loaded', view: v, now: Date.now() })
        dispatch({ type: 'unknown', value: 'idle' })
        dispatch({ type: 'notice', notice: null })
        return
      }
    }
    dispatch({ type: 'unknown', value: 'unconfirmed' })
    dispatch({ type: 'notice', notice: { tone: 'warn', text: 'Todavía no podemos confirmar si tu aceptación quedó registrada. Puedes verificar el estado otra vez; si sigue sin registrarse, puedes volver a enviarla con seguridad (no se duplica).' } })
  }

  async function handleOutcome(out, usedName) {
    switch (out.kind) {
      case 'accepted':
        dispatch({ type: 'done', done: { already: false, matches: true, acceptedAt: out.acceptedAt, revisionCode: out.revisionCode, name: usedName } })
        return
      case 'already': {
        dispatch({ type: 'done', done: { already: true, matches: out.matches, acceptedAt: out.acceptedAt, revisionCode: out.revisionCode, name: '' } })
        await refresh() // trae el registro autoritativo (nombre declarado y versión aceptada)
        return
      }
      case 'quote_changed': {
        const v = await refresh()
        dispatch({ type: 'notice', notice: { tone: 'warn', text: v.kind === 'open' ? 'La cotización cambió mientras la revisabas. Revisa la versión vigente y vuelve a confirmar para aceptarla.' : 'La cotización cambió. Actualiza la página para ver la versión vigente.' } })
        return
      }
      case 'invalid_input':
        dispatch({ type: 'fieldError', value: fieldMessage(out.field) })
        return
      case 'nonce': {
        await refresh()
        dispatch({ type: 'notice', notice: { tone: 'warn', text: 'El formulario venció. Lo actualizamos: confirma tus datos y vuelve a pulsar «Aceptar cotización».' } })
        return
      }
      case 'terminal': {
        await refresh()
        return
      }
      case 'ratelimited':
        dispatch({ type: 'retryAt', value: Date.now() + out.retryAfter * 1000 })
        dispatch({ type: 'notice', notice: { tone: 'warn', text: 'Hiciste demasiados intentos en poco tiempo. Espera un momento antes de volver a intentarlo.' } })
        return
      case 'rollback':
        dispatch({ type: 'retryAt', value: Date.now() + ERROR_COOLDOWN_S * 1000 })
        dispatch({ type: 'notice', notice: { tone: 'warn', text: 'El servicio no está disponible en este momento y no se registró tu aceptación. Inténtalo de nuevo en unos segundos.' } })
        return
      case 'unknown':
        await confirmUnknown(false)
        return
      default:
        dispatch({ type: 'retryAt', value: Date.now() + ERROR_COOLDOWN_S * 1000 })
        dispatch({ type: 'notice', notice: { tone: 'error', text: 'No pudimos procesar la solicitud. Actualiza la página e inténtalo de nuevo.' } })
    }
  }

  async function onAccept(e) {
    e.preventDefault()
    if (submitRef.current || !submitOk || cooling || !open) return
    submitRef.current = true
    dispatch({ type: 'busy', value: true })
    dispatch({ type: 'notice', notice: null })
    const usedName = sanitizeText(st.name, 400)
    try {
      const res = await fetchJson(apiUrl(token, '/accept'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: open.revision, name: usedName, consent: true, consent_version: open.consentVersion, nonce: open.nonce }),
      }, ACCEPT_TIMEOUT_MS)
      if (aliveRef.current) await handleOutcome(normalizeAccept(res), usedName)
    } finally {
      submitRef.current = false
      if (aliveRef.current) dispatch({ type: 'busy', value: false })
    }
  }

  // ----- vistas -----
  let body
  if (view.kind === 'loading') {
    body = <section className={s.panel}><p role="status" className={s.muted}>Cargando cotización…</p></section>
  } else if (view.kind === 'error' || view.kind === 'ratelimited') {
    body = (
      <StateCard title={view.kind === 'ratelimited' ? 'Demasiadas consultas' : 'No pudimos cargar la cotización'}>
        <p>{view.kind === 'ratelimited' ? 'Se hicieron muchas consultas en poco tiempo. Espera unos segundos e inténtalo de nuevo.' : 'Ocurrió un problema al consultar la información. Puedes intentarlo otra vez.'}</p>
        <button type="button" className={s.btn} onClick={reload} disabled={cooling}>{cooling ? `Reintentar en ${remaining} s` : 'Reintentar'}</button>
      </StateCard>
    )
  } else if (view.kind === 'invalid') {
    body = <StateCard title="Enlace no válido"><p>Este enlace no es válido o ya no está disponible. Pide a la empresa que te comparta uno nuevo.</p></StateCard>
  } else if (view.kind === 'unpublished') {
    body = <StateCard title="Cotización aún no disponible">{info(view)}<p>Esta cotización todavía no está lista para consultarse. Vuelve a intentarlo más tarde o contacta a la empresa.</p></StateCard>
  } else if (view.kind === 'unavailable') {
    body = <StateCard title="Cotización no disponible">{info(view)}<p>Por el momento no es posible mostrar ni aceptar esta cotización. Contacta a la empresa para recibir ayuda.</p></StateCard>
  } else if (view.kind === 'expired') {
    body = <StateCard title="Cotización vencida">{info(view)}<p>{view.validUntil ? `Esta cotización estuvo vigente hasta el ${formatDate(view.validUntil)} y ya no se puede aceptar.` : 'Esta cotización ya no está vigente y no se puede aceptar.'} Contacta a la empresa para solicitar una nueva.</p></StateCard>
  } else if (view.kind === 'contracted') {
    body = <StateCard title="Cotización contratada">{info(view)}<p>Esta cotización ya fue contratada. No necesitas hacer nada más aquí.</p></StateCard>
  } else if (view.kind === 'cancelled') {
    body = <StateCard title="Contratación cancelada">{info(view)}<p>La contratación de esta cotización fue cancelada. Contacta a la empresa si tienes dudas.</p></StateCard>
  } else if (view.kind === 'accepted' || st.done) {
    const d = st.done
    const rec = view.kind === 'accepted' ? view : null
    const when = formatDateTime((rec && rec.acceptedAt) || (d && d.acceptedAt) || '')
    const code = (rec && rec.revisionCode) || (d && d.revisionCode) || ''
    const who = (rec && rec.acceptedByName) || (d && d.name) || ''
    const mismatch = !!d && d.already && d.matches === false
    const docToShow = rec && rec.doc ? rec.doc : (open && d && !d.already ? open.doc : null)
    body = (
      <>
        <StateCard tone="ok" title={d && d.already ? 'Esta cotización ya había sido aceptada' : 'Cotización aceptada'}>
          {mismatch ? (
            <div className={`${s.notice} ${s.noticeWarn}`} role="alert">
              La versión que estabas viendo <strong>no</strong> es la que se aceptó. Se aceptó la versión {code}. Si tienes dudas, contacta a la empresa.
            </div>
          ) : null}
          {d && d.confirmed ? <p>Confirmamos que tu aceptación quedó registrada.</p> : (d && d.already ? <p>Ya se aceptó la versión {code}.</p> : <p>Registramos tu aceptación. Conserva esta pantalla como referencia.</p>)}
          <dl className={s.kvgrid}>
            <Row label="Cotización">{(rec && rec.folio) || (open && open.doc.folio) || ''}</Row>
            <Row label="Nombre declarado">{who}</Row>
            <Row label="Fecha de aceptación">{when}</Row>
            <Row label="Versión aceptada">{code}</Row>
          </dl>
          <p className={s.muted}>El nombre indicado es una declaración de quien aceptó; no es una verificación de identidad.</p>
        </StateCard>
        {docToShow ? <QuoteDoc doc={docToShow} view={{ validUntil: open ? open.validUntil : '', revisionCode: code }} /> : null}
      </>
    )
  } else {
    // open
    const doc = open.doc
    const supported = open.consentVersion === CONSENT_VERSION
    body = (
      <>
        <h1 className={s.srOnly}>Cotización {doc.folio}</h1>
        {stale ? <div className={`${s.notice} ${s.noticeWarn}`} role="alert">{STALE_LINK_NOTICE}</div> : null}
        <Notice notice={st.notice} />
        <QuoteDoc doc={doc} view={open} />
        <form className={`${s.panel} ${s.acceptForm}`} onSubmit={onAccept} aria-labelledby="q-aceptar" noValidate>
          <h2 id="q-aceptar" className={s.h2}>Aceptar cotización</h2>
          {!supported ? <p className={s.noticeError + ' ' + s.notice} role="alert">Esta cotización no se puede aceptar desde esta página. Contacta a la empresa.</p> : null}
          <div className={s.field}>
            <label htmlFor="q-nombre">Nombre completo de quien acepta</label>
            <input id="q-nombre" name="nombre" type="text" autoComplete="name" maxLength={120} value={st.name} onChange={(e) => dispatch({ type: 'name', value: e.target.value })} aria-describedby="q-nombre-ayuda q-nombre-error" aria-invalid={st.fieldError ? 'true' : 'false'} disabled={st.busy} />
            <p id="q-nombre-ayuda" className={s.help}>Escribe tu nombre tal como quieres que quede registrado. Es una declaración tuya.</p>
            <p id="q-nombre-error" className={s.fieldError} role={st.fieldError ? 'alert' : undefined}>{st.fieldError}</p>
          </div>
          {needsReview ? (
            <label className={s.check}>
              <input type="checkbox" checked={reviewedOn} onChange={(e) => dispatch({ type: 'reviewed', revision: open.revision, value: e.target.checked })} disabled={st.busy} />
              <span>{REVIEWED_TEXT} ({open.revisionCode})</span>
            </label>
          ) : null}
          <label className={s.check}>
            <input type="checkbox" checked={consentOn} onChange={(e) => dispatch({ type: 'consent', revision: open.revision, value: e.target.checked })} disabled={st.busy} />
            <span>{CONSENT_TEXT_V1}</span>
          </label>
          <div className={s.actions}>
            <button type="submit" className={s.btn} disabled={!submitOk || cooling} aria-busy={st.busy ? 'true' : 'false'}>
              {st.busy || st.unknown === 'checking' ? 'Enviando…' : (cooling ? `Espera ${remaining} s` : 'Aceptar cotización')}
            </button>
            {st.unknown === 'unconfirmed' ? <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => confirmUnknown(true)} disabled={st.busy}>Verificar estado</button> : null}
          </div>
          <p className={s.help}>Al aceptar se registra tu nombre declarado, la fecha y la versión de la cotización ({open.revisionCode}).</p>
        </form>
      </>
    )
  }

  const brandName = (open && open.doc.company.name) || (view.companyName || '') || (view.kind === 'accepted' && view.doc ? view.doc.company.name : '')
  const showLogo = !!open && open.logo && !st.logoFailed
  return (
    <div className={s.page}>
      <div className={s.wrap}>
        <Brand name={brandName} token={token} showLogo={showLogo} onLogoError={() => dispatch({ type: 'logoFailed' })} />
        {view.kind !== 'open' ? <Notice notice={st.notice} /> : null}
        {body}
        <footer className={s.footer}>Documento de consulta. Si tienes dudas, contacta a la empresa.</footer>
      </div>
    </div>
  )
}
