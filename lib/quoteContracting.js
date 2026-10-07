// lib/quoteContracting.js
// Fase 6.7C-1.1 — contratación manual decidida con el ESTADO FRESCO de la DB.
//
// Historial trabaja con un listado cargado hace rato: puede estar viejo (otra
// pestaña publicó una revisión, contrató o canceló). Por eso esta función
// recibe SOLO el id y relee la fila antes de elegir camino; el objeto del
// listado nunca participa en la decisión. contract_quote (la RPC) sigue
// siendo la autoridad final y conserva su idempotencia: aquí solo se decide
// si se puede contratar y qué enviarle. Este flujo nunca genera ni sube PDF.
//
//   fila fresca: lifecycle_status 'contratado'/'cancelado' -> se detiene con
//                un resultado explícito; NO se genera nada ni se llama a la RPC.
//   moderna + content_revision -> revisión 6.7: NO se regenera ni se sube
//                ningún PDF; se envía su pdf_storage_path SOLO como confirmación.
//   moderna sin content_revision -> NO PUBLICADA / NO CONTRATABLE (Fase
//                6.7C-1.2): se detiene ANTES de la RPC; no se genera ningún PDF
//                ni ruta canónica. Hay que abrirla y guardarla (publicar su
//                primera revisión) antes de contratarla.
//   no moderna (company_snapshot NULL) -> legacy puro, compatibilidad
//                histórica, sin PDF.
import { supabase } from './supabaseClient'

function stop(code, message, extra = {}) {
  return { ok: false, code, message, ...extra }
}

// deps (solo para pruebas): { supabase }
export async function contractQuoteFlow(quoteId, deps = {}) {
  const sb = deps.supabase || supabase

  // 1. Estado fresco
  const { data: fresh, error: readError } = await sb.from('quotes').select('*').eq('id', quoteId).maybeSingle()
  if (readError) {
    return stop('fresh_read_failed', 'No se pudo leer el estado actual de la cotización. La contratación no se realizó. Intenta nuevamente.')
  }
  if (!fresh) {
    return stop('not_found', 'La cotización ya no existe. La contratación no se realizó.', { reload: true })
  }
  if (fresh.status !== 'cotizacion') {
    return stop('not_a_quote', 'Este registro no es una cotización; no puede contratarse.', { reload: true })
  }

  // 2. Lifecycle fresco, manejado explícitamente
  if (fresh.lifecycle_status === 'contratado') {
    return stop('already_contracted', 'Esta cotización ya estaba contratada (probablemente desde otra pestaña o sesión). No se hizo ningún cambio.', { reload: true })
  }
  if (fresh.lifecycle_status === 'cancelado') {
    return stop('cancelled', 'Esta cotización está cancelada y ya no puede contratarse. No se hizo ningún cambio.', { reload: true })
  }
  if (fresh.lifecycle_status !== 'cotizacion') {
    return stop('unexpected_lifecycle', `Estado inesperado de la cotización (${fresh.lifecycle_status}); no se contrató.`, { reload: true })
  }

  // 3. Camino, decidido SOLO con la fila fresca
  const isModern = !!fresh.company_snapshot
  let plan = 'legacy'
  let pdfPath = null
  if (isModern && !fresh.content_revision) {
    // Fase 6.7C-1.2: una moderna sin publicación 6.7 válida no se contrata.
    // No se llama a la RPC (que también la rechaza: autoridad final) y,
    // sobre todo, no se genera ni sube ningún PDF.
    return stop('not_published', 'Esta cotización todavía no tiene una publicación válida. Ábrela y guárdala para publicar su primera revisión antes de contratarla.')
  }
  if (isModern && fresh.content_revision) {
    plan = 'revision'
    // La fila publicada es la autoridad. No se regenera ni se sube NADA.
    // Si el pdf_storage_path es null (inconsistencia), se envía null y la
    // RPC rechaza.
    pdfPath = fresh.pdf_storage_path || null
  }
  // Legacy puro (company_snapshot NULL): sin PDF, p NULL — la RPC lo ignora.

  // 4. La RPC decide: ante cualquier cambio entre esta lectura y su propio
  // bloqueo de fila (otra publicación, otra contratación) rechaza o es
  // idempotente, nunca contrata una revisión distinta a la confirmada.
  const { data, error } = await sb.rpc('contract_quote', { p_quote_id: quoteId, p_pdf_storage_path: pdfPath })
  if (error) {
    return stop('rpc_error', 'No se pudo completar la contratación: ' + error.message)
  }
  return { ok: true, data, plan }
}
