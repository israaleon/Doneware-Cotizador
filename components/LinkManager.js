// components/LinkManager.js
// P-TOKEN — «Gestionar enlace»: estado del enlace de aceptación de una cotización y, solo si la base lo permite, revocarlo o regenerarlo.
// Reglas de seguridad de la pantalla (la lógica vive en lib/linkManagement.js):
//  • Revocar NO cancela la contratación ni borra la aceptación, el recibo, los servicios ni los PDF ya descargados: solo corta el acceso del enlace.
//  • Regenerar solo en cotizaciones precontractuales; nunca se regenera solo.
//  • Cada operación pide motivo (lista cerrada), nota opcional breve y una SEGUNDA confirmación; un solo intento, sin reintento automático.
//  • Si el resultado es incierto se dice y se consulta el estado real; nunca se repite la operación por su cuenta.
'use client'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  defaultRpc, getLinkStatus, revokeLink, regenerateLink, getRegenerateResult, newRequestId, classifyRevisionLink, domainMessage, canRegenerateLink, validateNote, validateReason, REASONS, NOTE_MAX,
} from '@/lib/linkManagement'

const TONE = { ok: 'rec', warn: 'cot', bad: 'can', neutral: 'neutral' }
const ACTION_TEXT = {
  revoke: {
    title: 'Revocar el enlace',
    warn: 'Revocar corta el acceso de este enlace para cualquiera que lo tenga (PDF, mensajes y capturas ya enviados). NO cancela la contratación y NO borra la aceptación, el recibo, los servicios ni los archivos ya descargados.',
    confirm: 'Confirmar revocación',
    start: 'Revocar enlace…',
  },
  regenerate: {
    title: 'Regenerar el enlace',
    warn: 'Se creará un enlace NUEVO y el actual (si existe) se revocará: los PDF y mensajes ya enviados con el enlace anterior dejarán de funcionar y habrá que volver a publicar o reenviar. No cambia la versión publicada ni los PDF existentes.',
    confirm: 'Confirmar regeneración',
    start: 'Regenerar enlace…',
  },
}

// Estado consultado → vista. «No habilitado» no muestra estado ni operaciones; un 42501 inesperado se muestra (no se oculta).
function statusToView(s) {
  if (s.ok) return { phase: 'ready', status: s }
  if (s.kind === 'not_enabled') return { phase: 'unavailable' }
  return { phase: 'error', text: s.kind === 'forbidden' ? `La base denegó el permiso de forma inesperada (código ${s.code || '42501'}). No se hizo ningún cambio.` : s.kind === 'domain' ? domainMessage(s.code) : 'No se pudo consultar el estado del enlace. Intenta de nuevo.' }
}

export default function LinkManager({ rec, onClose, onChanged, rpc = defaultRpc }) {
  const [view, setView] = useState({ phase: 'loading' })
  const [action, setAction] = useState(null)               // null | { kind, step: 'form' | 'confirm' }
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)               // { tone, text }
  const busyRef = useRef(false)
  const aliveRef = useRef(true)
  const reqRef = useRef(0)
  const reqIdRef = useRef(null)                          // identidad de la acción de regenerar en curso (estable en doble clic, resultado incierto y reintento)

  async function refresh() {
    const id = ++reqRef.current
    const s = await getLinkStatus(rpc, rec.id)
    if (!aliveRef.current || id !== reqRef.current) return null
    setView(statusToView(s))
    return s
  }
  useEffect(() => {
    aliveRef.current = true
    const id = ++reqRef.current
    getLinkStatus(rpc, rec.id).then((s) => { if (aliveRef.current && id === reqRef.current) setView(statusToView(s)) })
    return () => { aliveRef.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.id])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busyRef.current) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function begin(kind) {
    setResult(null); setFormError(''); setReason(''); setNote('')
    reqIdRef.current = kind === 'regenerate' ? newRequestId() : null      // cada acción explícita nueva = identidad nueva
    setAction({ kind, step: 'form' })
  }
  function next() {
    if (!validateReason(reason)) { setFormError('Elige un motivo de la lista.'); return }
    const n = validateNote(note)
    if (!n.ok) { setFormError(n.message); return }
    setFormError('')
    setAction((a) => ({ ...a, step: 'confirm' }))
  }
  function finish(msg, keepAction) {
    setResult(msg)
    if (!keepAction) { setAction(null); reqIdRef.current = null } else setAction({ kind: 'regenerate', step: 'recover' })
  }
  const regenText = (r, recovered) => `${r.replayed || recovered ? 'La acción ya se había aplicado: se muestra el MISMO resultado y NO se creó otro enlace. ' : ''}Enlace regenerado: ahora la generación activa es la ${r.generation}${r.previousRevoked ? ' y la anterior quedó revocada' : ''}. Los PDF anteriores no funcionan con el enlace nuevo: vuelve a publicar o reenvía.`
  async function after(superseded) {
    const s = await refresh()                                  // siempre se muestra el estado real, incluso tras un resultado incierto
    if (superseded && s && s.ok && s.active_generation !== superseded.generation) {
      setResult({ tone: 'warn', text: superseded.text + ` ATENCIÓN: otra acción posterior ya reemplazó este enlace (hoy la generación activa es la ${s.active_generation ?? 'ninguna'}): el enlace que acabas de crear ya no funciona.` })
    }
    if (aliveRef.current && typeof onChanged === 'function') onChanged()
    busyRef.current = false
    if (aliveRef.current) setBusy(false)
  }
  // Consulta de SOLO LECTURA del resultado de la acción de regenerar por su identidad (nunca genera).
  async function consult() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const g = await getRegenerateResult(rpc, { requestId: reqIdRef.current, quoteId: rec.id })
    let sup = null
    if (g.ok && g.found) { const text = regenText(g, true); finish({ tone: 'ok', text }, false); sup = { generation: g.generation, text } }
    else if (g.ok) finish({ tone: 'warn', text: 'El servidor sigue sin tener registro de esta acción: no se aplicó (o todavía está en curso). No se generó ningún enlace. Puedes consultar de nuevo o reintentar ESTA MISMA acción.' }, true)
    else finish({ tone: 'warn', text: 'No se pudo consultar el resultado de la acción. No se generó nada nuevo. Intenta consultar de nuevo.' }, true)
    await after(sup)
  }
  async function run() {
    if (busyRef.current || !action) return                 // doble clic: una sola operación
    busyRef.current = true
    setBusy(true)
    const kind = action.kind
    let r
    try {
      r = kind === 'revoke' ? await revokeLink(rpc, { quoteId: rec.id, reason, note }) : await regenerateLink(rpc, { quoteId: rec.id, requestId: reqIdRef.current, reason, note })
    } catch {
      r = { ok: false, kind: 'unknown_result' }
    }
    let recovered = false
    if (!r.ok && kind === 'regenerate' && r.kind === 'unknown_result') {
      // Respuesta perdida o inesperada: se RECUPERA el resultado por la identidad de la acción (solo lectura); jamás se vuelve a generar por su cuenta.
      const g = await getRegenerateResult(rpc, { requestId: reqIdRef.current, quoteId: rec.id })
      if (g.ok && g.found) { r = { ok: true, ...g }; recovered = true }
      else if (g.ok) r = { ok: false, kind: 'not_applied' }
    }
    let sup = null
    if (r.ok && kind === 'revoke') finish({ tone: 'ok', text: r.status === 'already_revoked' ? 'El enlace ya estaba revocado; no se cambió nada.' : `Enlace revocado (generación ${r.generation ?? '?'}).${r.acceptedBefore ? ' La cotización ya había sido aceptada: la aceptación se conserva; quien abra el enlace verá «Enlace no válido».' : ''} La contratación NO se canceló.` }, false)
    else if (r.ok) { const text = regenText(r, recovered); finish({ tone: 'ok', text }, false); sup = { generation: r.generation, text } }
    else if (r.kind === 'not_applied') finish({ tone: 'warn', text: 'No se encontró registro de esta acción en el servidor: no se aplicó (o todavía está en curso). No se generó ningún enlace nuevo. Puedes consultar de nuevo o reintentar ESTA MISMA acción (misma identidad: si ya se había aplicado, no se crea otro enlace).' }, true)
    else if (r.kind === 'unknown_result' && kind === 'regenerate') finish({ tone: 'warn', text: 'No se pudo confirmar el resultado ni consultarlo. NO se repitió la operación. Consulta de nuevo antes de reintentar.' }, true)
    else if (r.kind === 'unknown_result') finish({ tone: 'warn', text: 'No se pudo confirmar el resultado (respuesta perdida o inesperada). NO se repitió la operación; abajo se muestra el estado actual real. Revísalo antes de intentarlo otra vez.' }, false)
    else if (r.kind === 'not_enabled') finish({ tone: 'bad', text: 'Esta operación todavía no está habilitada en la base de datos. No se hizo ningún cambio.' }, false)
    else if (r.kind === 'forbidden') finish({ tone: 'bad', text: `La base denegó el permiso de forma inesperada (código ${r.code || '42501'}). No se hizo ningún cambio. Avisa a quien administra el sistema.` }, false)
    else if (r.kind === 'domain') finish({ tone: 'bad', text: domainMessage(r.code) + ' No se hizo ningún cambio.' }, false)
    else finish({ tone: 'bad', text: (r.message || 'Solicitud inválida.') + ' No se hizo ningún cambio.' }, false)
    await after(sup)
  }

  const st = view.phase === 'ready' ? view.status : null
  const activeGen = st ? st.active_generation : null
  const currentCode = typeof rec.content_revision === 'string' ? rec.content_revision.slice(0, 8) : ''
  const precontractual = canRegenerateLink(rec)
  const labelState = rec.lifecycle_status === 'contratado' ? 'contratada (aceptada o marcada a mano)' : rec.lifecycle_status === 'cancelado' ? 'cancelada' : 'precontractual'

  const body = (
    <div role="dialog" aria-modal="true" aria-labelledby="lm-title" data-testid="link-manager"
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,20,27,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 16 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busyRef.current) onClose() }}>
      <div className="panel" style={{ width: 'min(680px, 100%)', maxHeight: '90vh', overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
          <h3 id="lm-title" style={{ margin: 0 }}>Gestionar enlace · {rec.folio}</h3>
          <button className="btn ghost small" onClick={onClose} disabled={busy}>Cerrar</button>
        </div>
        <div className="muted" style={{ margin: '6px 0 12px' }}>{rec.client_name} · cotización {labelState}</div>

        {view.phase === 'loading' && <div role="status">Consultando el estado del enlace…</div>}
        {view.phase === 'unavailable' && (
          <div role="status">La gestión de enlaces todavía <strong>no está habilitada</strong> en la base de datos: no hay operaciones disponibles y no se muestra ningún estado.</div>
        )}
        {view.phase === 'error' && (
          <div>
            <div role="alert" style={{ marginBottom: 10 }}>{view.text}</div>
            <button className="btn teal small" onClick={() => { setView({ phase: 'loading' }); refresh() }}>Reintentar</button>
          </div>
        )}

        {st && (
          <>
            <div style={{ marginBottom: 12 }} data-testid="lm-active">
              {activeGen
                ? <span className="badge rec">ENLACE ACTIVO · GENERACIÓN {activeGen}</span>
                : <span className="badge can">SIN ENLACE ACTIVO</span>}
              <span className="muted" style={{ marginLeft: 8 }}>{activeGen ? 'Es el que usan «Enviar a» y las nuevas publicaciones.' : 'Está revocado o aún no se ha creado; las nuevas publicaciones no pueden continuar hasta regenerarlo.'}</span>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div className="muted" style={{ fontWeight: 600, marginBottom: 4 }}>Enlace que lleva el PDF de cada versión publicada</div>
              {!st.revisions.length && <div className="muted">Esta cotización no tiene versiones registradas.</div>}
              {[...st.revisions].reverse().map((r) => {
                const c = classifyRevisionLink(r, activeGen)
                return (
                  <div key={r.revision_code} data-testid={`lm-rev-${r.revision_code}`} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{r.revision_code}{r.revision_code === currentCode ? ' · vigente' : ''}</span>
                    <span className={`badge ${TONE[c.tone]}`}>{c.state === 'current' ? 'ENLACE VIGENTE' : c.state === 'unknown' ? 'DESCONOCIDO' : c.state === 'no_active' ? 'REVOCADO' : 'GENERACIÓN ANTERIOR'}</span>
                    <span className="muted" style={{ flex: 1 }}>{c.text}</span>
                  </div>
                )
              })}
            </div>

            {result && <div role="status" data-testid="lm-result" className={`badge ${TONE[result.tone]}`} style={{ display: 'block', whiteSpace: 'normal', padding: '8px 12px', marginBottom: 12 }}>{result.text}</div>}

            {!action && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn ghost small" disabled={busy || !activeGen} onClick={() => begin('revoke')} title={activeGen ? '' : 'No hay un enlace activo que revocar'}>{ACTION_TEXT.revoke.start}</button>
                {precontractual
                  ? <button className="btn teal small" disabled={busy} onClick={() => begin('regenerate')}>{ACTION_TEXT.regenerate.start}</button>
                  : <span className="muted">Regenerar no está disponible: la cotización ya no es precontractual (solo puede revocarse).</span>}
              </div>
            )}

            {action && action.step === 'recover' && (
              <div data-testid="lm-recover" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Resultado de «Regenerar» sin confirmar</div>
                <div className="muted" style={{ marginBottom: 10 }}>Esta acción tiene una identidad propia: consultar su resultado no genera nada, y reintentarla (con la MISMA identidad) nunca crea un segundo enlace si la primera vez ya se aplicó.</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn small" disabled={busy} onClick={consult}>Consultar resultado</button>
                  <button className="btn ghost small" disabled={busy} onClick={run}>Reintentar esta acción</button>
                  <button className="btn ghost small" disabled={busy} onClick={() => { setAction(null); reqIdRef.current = null }}>Descartar</button>
                </div>
              </div>
            )}

            {action && action.step !== 'recover' && (
              <div data-testid="lm-action" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{ACTION_TEXT[action.kind].title}</div>
                <div className="muted" style={{ marginBottom: 10 }}>{ACTION_TEXT[action.kind].warn}</div>
                {action.step === 'form' ? (
                  <>
                    <div className="field">
                      <label htmlFor="lm-reason">Motivo (obligatorio)</label>
                      <select id="lm-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
                        <option value="">Elige un motivo…</option>
                        {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="lm-note">Nota interna (opcional, máx. {NOTE_MAX} caracteres; sin datos sensibles)</label>
                      <input id="lm-note" value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} />
                    </div>
                    {formError && <div className="fielderr" role="alert">{formError}</div>}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn small" onClick={next}>Continuar</button>
                      <button className="btn ghost small" onClick={() => setAction(null)}>Cancelar</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ marginBottom: 10 }}>Motivo: <strong>{REASONS.find((r) => r.value === reason)?.label}</strong>{note.trim() ? <> · Nota: {note.trim()}</> : null}</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn small" disabled={busy} onClick={run}>{busy ? 'Procesando…' : ACTION_TEXT[action.kind].confirm}</button>
                      <button className="btn ghost small" disabled={busy} onClick={() => setAction((a) => ({ ...a, step: 'form' }))}>Volver</button>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
        <div className="muted" style={{ marginTop: 12 }}>Revocar no elimina contenido ya descargado: PDF, capturas y mensajes ya enviados siguen existiendo; solo deja de funcionar el acceso.</div>
      </div>
    </div>
  )
  return typeof document !== 'undefined' ? createPortal(body, document.body) : null
}
