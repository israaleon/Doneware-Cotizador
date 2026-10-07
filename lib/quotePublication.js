// lib/quotePublication.js
// Fase 6.7C-1 — publicación de una REVISIÓN inmutable de una cotización
// precontractual. Orquesta, en este orden y sin transacción distribuida
// (Storage y Postgres no comparten una):
//   1. base      = row.content_revision (null si nunca se publicó)
//   2. R         = UUID nuevo
//   3. logo      = SOLO si config.logo_url está declarado: sus bytes se obtienen
//                  UNA vez, se convierten a DataURL y se comprueba que SE PUEDEN
//                  incrustar. Si cualquiera de esos pasos falla, la publicación
//                  falla aquí, sin escribir Storage ni DB. Sin config.logo_url
//                  se publica sin logo. Se decide la ruta inmutable de la copia
//                  (logoStoragePath) pero TODAVÍA no se sube.
//   4. snapshot  = published_snapshot candidato (forma de lib/quoteRevision.js);
//                  referencia logo_storage_path solo si esta revisión va a
//                  almacenar esa copia (paso 7).
//   5. valid_until candidato (solo para renderizar; la autoridad es la DB)
//   6. PDF       = buildPdfDoc(SNAPSHOT, {}, { logoDataUrl, strictLogo }) — nunca
//                  la fila viva; con logo declarado, un fallo al incrustarlo
//                  aborta, y se verifica que el PDF contiene una imagen. Se
//                  genera y verifica COMPLETO antes de escribir nada en Storage.
//   7. Storage   = con el PDF ya verificado: primero la copia inmutable del logo
//                  (upsert:false, mismos bytes que el PDF), después
//                  quotes/{id}/revisions/{R}.pdf (upsert:false)
//   8. CAS       = UPDATE ... WHERE id AND lifecycle_status='cotizacion'
//                  AND content_revision = base (o IS NULL) — publica campos,
//                  published_snapshot, content_revision y pdf_storage_path JUNTOS
//   9. verifica  = content_revision, pdf_storage_path y valid_until devueltos
//
// Storage siempre precede al CAS: si falla cualquier subida NO se ejecuta el
// CAS y nada cambia en la DB. Si el CAS no afecta filas es un CONFLICTO: jamás
// se convierte en éxito. Todos los fallos de los pasos 1-6 ocurren ANTES de
// escribir en Storage o en la DB (no dejan huérfanos).
// Nunca se borra nada automáticamente: lo subido cuyo CAS falló (o cuya
// subida posterior falló) queda HUÉRFANO en Storage (inevitable: no hay
// transacción compartida) y se reporta; ver removeOrphanRevisionIfUnreferenced
// (no se invoca sola).
import { supabase } from './supabaseClient'
import { buildPdfDoc, blobToDataUrl, assertLogoEmbeddable } from './pdf'
import { fetchCurrentLogo, uploadToPath, removePaths } from './quoteLogo'
import { uploadRevisionPdf } from './quotePdfStorage'
import {
  computeValidUntilMX, buildPublishedSnapshot, getRevisionPdfPath, getRevisionLogoPath,
} from './quoteRevision'

// Texto legible de por qué falló fetchCurrentLogo (lib/quoteLogo.js).
function describeLogoFetchFailure(fetched) {
  switch (fetched.reason) {
    case 'fetch-error': return 'error de red o CORS' + (fetched.detail ? ': ' + fetched.detail : '')
    case 'http-error': return 'respuesta HTTP ' + fetched.detail
    case 'mime-no-reconocido': return 'tipo de archivo no reconocido (' + (fetched.detail || 'desconocido') + '); se admite PNG o JPEG'
    default: return fetched.reason || 'causa desconocida'
  }
}

// `uncertain`: el resultado del CAS es ambiguo (error de red/DB sin respuesta
// concluyente), así que no se afirma que los archivos sean huérfanos.
function orphanNote(orphans, uncertain = false) {
  const list = [orphans.pdf, orphans.logo].filter(Boolean)
  if (!list.length) return ''
  if (uncertain) return ` Es posible que hayan quedado archivos huérfanos en Storage (no se borraron): ${list.join(', ')}.`
  return ` Quedó(aron) archivo(s) huérfano(s) en Storage, sin afectar la cotización (no se borraron): ${list.join(', ')}.`
}

// Defensa en profundidad del modo estricto: el PDF ya serializado debe
// contener un objeto imagen. Falla cerrado (si no puede comprobarlo, no hay logo).
async function pdfBlobHasImage(blob) {
  try {
    const text = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()))
    return text.includes('/Subtype /Image')
  } catch {
    return false
  }
}

function failure(code, message, extra = {}) {
  return { ok: false, code, message, ...extra }
}

// row: fila REAL de quotes (id, folio, created_at, content_revision, ...), de
//      la que se parte (cotización recién creada, o editingRec).
// payload: campos editables YA calculados (items, totales, snapshots de
//      cliente/empresa, ...) — lo mismo que antes se enviaba al UPDATE/INSERT.
// config: fila de app_config (solo se usa para obtener el logo vigente).
export async function publishQuoteRevision({ row, payload, config }) {
  const warnings = [] // se conserva en el resultado (la UI lo muestra si hay); el logo ya no genera avisos: o se incrusta o la publicación falla
  const orphans = { pdf: null, logo: null }

  if (!row || !row.id) return failure('invalid_input', 'No hay una cotización base para publicar.')
  if (row.status !== 'cotizacion' || row.lifecycle_status !== 'cotizacion') {
    return failure('not_editable', 'Esta cotización ya no es editable (está contratada o cancelada); no se publicó nada.')
  }
  const validDaysNum = Number(payload.valid_days)
  if (payload.valid_days === '' || payload.valid_days == null || !Number.isInteger(validDaysNum)) {
    return failure('invalid_valid_days', 'La vigencia (días) debe ser un número entero; no se publicó nada.')
  }
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    return failure('no_uuid', 'Este navegador no puede generar identificadores seguros (se requiere HTTPS); no se publicó nada.')
  }

  // 1-2. base y revisión nueva
  const baseRevision = row.content_revision ?? null
  const revision = crypto.randomUUID()
  const pdfPath = getRevisionPdfPath(row.id, revision)

  // 3. Logo (sin config.logo_url: se publica sin logo, sin ningún aviso).
  // Con config.logo_url el logo es PARTE del documento contractual: debe
  // obtenerse, convertirse y poder incrustarse, o la publicación falla ahora,
  // antes de tocar Storage o la DB (los cambios siguen en el formulario).
  // Los bytes se obtienen UNA sola vez; esos mismos bytes (a) se incrustan en
  // el PDF y (b) se subirán como copia inmutable de ESTA revisión. Nunca se
  // vuelve a descargar el logo ni se consulta el logo vivo durante el render.
  let logoDataUrl = null
  let logoBlob = null
  let logoContentType = null
  let logoStoragePath = null
  if (config && config.logo_url) {
    const fetched = await fetchCurrentLogo(config.logo_url)
    if (!fetched.ok) {
      return failure('logo_fetch_failed', 'No se pudo obtener el logo configurado (' + describeLogoFetchFailure(fetched) + '); no se publicó nada y no se subió ningún archivo. Revisa la conexión o el logo en Configuración y vuelve a guardar; tus cambios siguen en el formulario.')
    }
    logoBlob = new Blob([fetched.blob], { type: fetched.contentType })
    logoContentType = fetched.contentType
    try { logoDataUrl = await blobToDataUrl(logoBlob) } catch { logoDataUrl = null }
    if (!logoDataUrl) {
      return failure('logo_encode_failed', 'No se pudo leer el logo configurado para incrustarlo; no se publicó nada y no se subió ningún archivo. Vuelve a guardar; tus cambios siguen en el formulario.')
    }
    try {
      assertLogoEmbeddable(logoDataUrl)
    } catch (e) {
      return failure('logo_embed_failed', 'El logo de Configuración no se puede incrustar en el PDF (' + (e && e.message ? e.message : e) + '); no se publicó nada y no se subió ningún archivo. Revisa el logo en Configuración y vuelve a guardar; tus cambios siguen en el formulario.')
    }
    // Ruta inmutable de la copia: el snapshot la referencia porque ESTA
    // revisión va a almacenar esos bytes (paso 7, tras verificar el PDF).
    logoStoragePath = getRevisionLogoPath(row.id, revision)
  }

  const companySnapshot = { ...(payload.company_snapshot || {}) }
  delete companySnapshot.logo_storage_path
  if (logoStoragePath) companySnapshot.logo_storage_path = logoStoragePath

  // 4-5. snapshot candidato + valid_until candidato (solo render)
  const validUntilPrinted = computeValidUntilMX(row.created_at, validDaysNum)
  const snapshot = buildPublishedSnapshot({
    status: 'cotizacion',
    folio: row.folio,
    related_folio: row.related_folio ?? null,
    created_at: row.created_at,
    ...payload,
    company_snapshot: companySnapshot,
    valid_until: validUntilPrinted,
  })

  // 6. PDF desde el SNAPSHOT (config vacío: nada vivo puede filtrarse)
  let blob
  try {
    const doc = await buildPdfDoc(snapshot, {}, { logoDataUrl, strictLogo: !!logoDataUrl })
    blob = doc.output('blob')
  } catch (e) {
    return failure('pdf_build_failed', 'No se pudo generar el PDF (' + (e && e.message ? e.message : e) + '); no se publicó nada, no se subió ningún archivo y tus cambios siguen en el formulario.', { orphans, detail: e && e.message })
  }
  if (logoDataUrl && !(await pdfBlobHasImage(blob))) {
    return failure('logo_not_in_pdf', 'El PDF generado no contiene el logo declarado en el snapshot; no se publicó nada, no se subió ningún archivo y tus cambios siguen en el formulario.', { orphans })
  }

  // 7. Storage inmutable, SOLO con el PDF ya generado y verificado. Primero
  // la copia del logo (los mismos bytes que se incrustaron), luego el PDF.
  // Si cualquier subida falla, NO hay CAS.
  if (logoStoragePath) {
    const logoUp = await uploadToPath(logoStoragePath, logoBlob, logoContentType)
    if (!logoUp.ok) {
      return failure('logo_upload_failed', 'No se pudo subir la copia del logo a Storage; no se subió el PDF, no se publicó nada y tus cambios siguen en el formulario.', { orphans, detail: logoUp.error && logoUp.error.message })
    }
    orphans.logo = logoStoragePath
  }
  const uploaded = await uploadRevisionPdf(pdfPath, blob)
  if (!uploaded.ok) {
    return failure('storage_upload_failed', 'No se pudo subir el PDF a Storage; no se publicó nada (la revisión anterior sigue vigente) y tus cambios siguen en el formulario.' + orphanNote(orphans), { orphans, detail: uploaded.error && uploaded.error.message })
  }
  orphans.pdf = pdfPath

  // 8. CAS
  const update = {
    ...payload,
    company_snapshot: companySnapshot,
    published_snapshot: snapshot,
    content_revision: revision,
    pdf_storage_path: pdfPath,
  }
  let query = supabase.from('quotes').update(update)
    .eq('id', row.id).eq('status', 'cotizacion').eq('lifecycle_status', 'cotizacion')
  query = baseRevision === null ? query.is('content_revision', null) : query.eq('content_revision', baseRevision)
  const { data, error } = await query.select().maybeSingle()

  if (error) {
    return failure('db_error', 'No se pudo publicar en la base de datos: ' + error.message + '. Tus cambios siguen en el formulario. Verifica en Historial si la versión llegó a publicarse antes de reintentar.' + orphanNote(orphans, true), { orphans })
  }

  if (!data) {
    // 0 filas: CONFLICTO (nunca éxito). Se consulta, solo lectura, para decir por qué.
    const { data: current } = await supabase.from('quotes').select('id, lifecycle_status, content_revision').eq('id', row.id).maybeSingle()
    let message
    let code
    if (!current) {
      code = 'conflict_deleted'
      message = 'La cotización ya no existe (fue eliminada desde otra sesión).'
    } else if (current.lifecycle_status !== 'cotizacion') {
      code = 'conflict_lifecycle'
      message = `La cotización ya está ${current.lifecycle_status === 'cancelado' ? 'cancelada' : 'contratada'}; ya no puede editarse.`
    } else if ((current.content_revision ?? null) !== baseRevision) {
      code = 'conflict_revision'
      message = 'Otra edición (otra pestaña o usuario) publicó una versión más reciente mientras editabas.'
    } else {
      code = 'conflict_unknown'
      message = 'La base de datos no aplicó el cambio (0 filas) sin una causa identificable; puede ser una política de acceso.'
    }
    return failure(code, `${message} NO se sobrescribió nada y NO se publicó esta versión. Tus cambios siguen en el formulario, pero para continuar debes recargar la cotización.` + orphanNote(orphans), { conflict: true, orphans, current })
  }

  // 9. Verificación explícita contra lo que devolvió PostgreSQL
  const problems = []
  if (data.content_revision !== revision) problems.push(`content_revision devuelta (${data.content_revision}) ≠ ${revision}`)
  if (data.pdf_storage_path !== pdfPath) problems.push(`pdf_storage_path devuelta (${data.pdf_storage_path}) ≠ ${pdfPath}`)
  if ((data.valid_until ?? null) !== validUntilPrinted) problems.push(`valid_until en la base (${data.valid_until}) ≠ el impreso en el PDF (${validUntilPrinted})`)
  if (problems.length) {
    return failure('verification_failed',
      'La publicación NO se considera exitosa: ' + problems.join('; ') + '. La base de datos puede haber guardado esta revisión; revisa la cotización antes de continuar.',
      { row: data })
  }

  return { ok: true, row: data, blob, warnings, revision, pdfPath }
}

// Limpieza SEGURA de una revisión que quedó huérfana. NO se invoca
// automáticamente en 6.7C-1 (borrar a ciegas podría ocultar otro problema);
// existe para que una fase posterior o un operador la use. Solo borra si
// DEMUESTRA, leyendo la fila en este momento, que la revisión NO es la
// vigente (ni por content_revision ni por pdf_storage_path). Ante cualquier
// duda (error de lectura, es la vigente) no borra nada.
export async function removeOrphanRevisionIfUnreferenced(quoteId, revisionId) {
  const pdfPath = getRevisionPdfPath(quoteId, revisionId)
  const logoPath = getRevisionLogoPath(quoteId, revisionId)
  const { data: current, error } = await supabase.from('quotes').select('id, content_revision, pdf_storage_path').eq('id', quoteId).maybeSingle()
  if (error) return { ok: false, removed: false, reason: 'no_verificable' }
  if (current && (current.content_revision === revisionId || current.pdf_storage_path === pdfPath)) {
    return { ok: false, removed: false, reason: 'es_la_revision_vigente' }
  }
  const removed = await removePaths([pdfPath, logoPath])
  return { ok: removed.ok, removed: removed.ok, reason: removed.ok ? 'huerfana_eliminada' : 'fallo_al_eliminar' }
}
