// lib/pdf.js
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { fmt } from './calc'
import { resolveDocumentModel } from './pdfModel'
import { downloadHistoricalLogo } from './quoteLogo'
import { getQuotePdfPath, uploadQuotePdf, downloadPersistedPdf } from './quotePdfStorage'
import { formatValidUntilForPdf } from './quoteRevision'

const MARGIN_X = 48
const PAGE_RIGHT = 564
// Carta en pt (612x792) con margen de 48pt: el contenido nunca debe pasar de
// aquí. Fase 6.2 — antes de esto no existía ninguna protección de paginación;
// esto es infraestructura nueva, no un cambio de layout: en cualquier
// documento (legacy o especializado) que ya cupiera sin salto de página, el
// resultado es idéntico a 6.1 — solo actúa cuando el contenido es largo.
const PAGE_BOTTOM = 744
const PAGE_TOP_CONTINUATION = 56

const QUOTE_TYPE_LABEL = { instalacion: 'Instalación', servicio: 'Servicio', venta: 'Venta de productos' }

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

async function loadImageAsDataUrl(url) {
  const res = await fetch(url)
  const blob = await res.blob()
  return blobToDataUrl(blob)
}

// Fase 6.5 — dispara la descarga de un Blob ya serializado, sin volver a
// construir ni serializar el PDF. Reemplaza a doc.save() en el camino
// moderno para garantizar que el binario descargado por el usuario y el
// subido a Storage sean exactamente el mismo objeto Blob.
export function triggerPdfDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// Fase 6.4B — prioridad del logo: histórico privado del snapshot -> logo_url
// del MISMO snapshot (o de liveConfig si es legacy, ya resuelto por
// pdfModel.js) -> sin logo. Si existe logo_storage_path pero la descarga
// falla, NUNCA se cae al logo actual de Configuración — solo al logo_url que
// ya venía congelado en este mismo snapshot. Nunca lanza: en el peor caso
// devuelve null y el PDF sigue generándose sin logo.
//
// Fase 6.7C-1: si el llamador pasa `options.logoDataUrl` (aunque sea null),
// ese valor se usa TAL CUAL y no se consulta ninguna fuente viva — así el PDF
// de una revisión publicada usa exactamente los bytes del logo que acompañan
// a su snapshot y nunca mezcla un logo obtenido aparte.
async function resolveLogoDataUrl(model, options) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'logoDataUrl')) {
    return options.logoDataUrl
  }
  if (model.company.logo_storage_path) {
    const blob = await downloadHistoricalLogo(model.company.logo_storage_path)
    if (blob) {
      try { return await blobToDataUrl(blob) } catch (e) { /* seguir al fallback de abajo */ }
    }
  }
  if (model.company.logo_url) {
    try { return await loadImageAsDataUrl(model.company.logo_url) } catch (e) { return null }
  }
  return null
}

// Fase 6.7C-1.1 — comprobación barata y previa (documento descartable de una
// página) de que estos bytes de logo SÍ se pueden incrustar. Lanza si no.
// Permite que la publicación falle antes de subir cualquier archivo; la
// garantía final sigue siendo el modo estricto del PDF real.
export function assertLogoEmbeddable(dataUrl) {
  const fmt = typeof dataUrl === 'string' && dataUrl.indexOf('image/png') > -1 ? 'PNG' : 'JPEG'
  const probe = new jsPDF({ unit: 'pt', format: 'letter' })
  probe.addImage(dataUrl, fmt, 0, 0, 1, 1)
  if (!probe.output().includes('/Subtype /Image')) throw new Error('el PDF de prueba no contiene la imagen')
}

// Si escribir `neededHeight` más no cabe antes del margen inferior, salta de
// página y devuelve el nuevo punto de inicio; si cabe, no hace nada.
function ensureSpace(doc, y, neededHeight) {
  if (y + neededHeight > PAGE_BOTTOM) {
    doc.addPage()
    return PAGE_TOP_CONTINUATION
  }
  return y
}

// Escribe "Etiqueta: " en negritas seguido del valor en texto normal,
// en la misma línea. Devuelve la posición y siguiente.
function writeLabeledLine(doc, label, value, x, y) {
  y = ensureSpace(doc, y, 13)
  doc.setFont('helvetica', 'bold')
  doc.text(label + ': ', x, y)
  const labelWidth = doc.getTextWidth(label + ': ')
  doc.setFont('helvetica', 'normal')
  doc.text(String(value), x + labelWidth, y)
  return y + 13
}

// Texto largo: pagina línea por línea (nunca corta contenido fuera del
// margen); si un párrafo no cabe completo, continúa en la siguiente página
// sin repetir ningún encabezado.
function writeWrapped(doc, text, x, y, maxWidth) {
  doc.setFontSize(9)
  const lines = doc.splitTextToSize(text, maxWidth)
  lines.forEach((line) => {
    y = ensureSpace(doc, y, 12)
    doc.text(line, x, y)
    y += 12
  })
  return y
}

// ---------- Agrupación de conceptos (Fase 6.2) ----------
// Puramente visual: NUNCA modifica `item.item_type` ni ningún otro campo del
// item almacenado. "Adicionales" es el resultado de no reconocer el
// item_type como 'producto' ni 'servicio' — incluye legacy (sin item_type),
// manuales (item_type=null por diseño) y catálogo real con type=NULL (así
// están todos los conceptos de catálogo hoy). No es una reclasificación
// persistente ni se infiere nada por nombre/SKU/categoría/source/specs.
const ITEM_GROUPS = [
  { label: 'Productos', match: (it) => it.item_type === 'producto' },
  { label: 'Servicios', match: (it) => it.item_type === 'servicio' },
  { label: 'Adicionales', match: (it) => it.item_type !== 'producto' && it.item_type !== 'servicio' },
]

function specializedTableBody(items) {
  return items.map((it) => [
    it.name || '-',
    it.unit || '',
    String(it.qty || 0),
    fmt(it.price || 0),
    fmt((it.price || 0) * (it.qty || 0)),
  ])
}

// Dibuja los conceptos agrupados en Productos/Servicios/Adicionales — solo
// se imprimen los grupos que tienen al menos un concepto. Devuelve la
// posición y lista para empezar el bloque de totales (ya incluye el espacio
// después de la última tabla).
function drawGroupedItems(doc, model, y) {
  ITEM_GROUPS.forEach((group) => {
    const groupItems = model.items.filter(group.match)
    if (!groupItems.length) return
    // El título de un grupo nunca debe quedar solo al final de una página:
    // se reserva espacio para el título + al menos una fila.
    y = ensureSpace(doc, y, 40)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(20, 20, 20)
    doc.text(group.label, MARGIN_X, y)
    y += 14
    autoTable(doc, {
      startY: y,
      head: [['Concepto', 'Unidad', 'Cantidad', 'P. Unitario', 'Importe']],
      body: specializedTableBody(groupItems),
      margin: { left: MARGIN_X, right: 48 },
      styles: { fontSize: 9.5, cellPadding: 6, textColor: [40, 45, 50] },
      headStyles: { fillColor: [18, 24, 31], textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles: {
        1: { halign: 'center', cellWidth: 60 },
        2: { halign: 'center', cellWidth: 60 },
        3: { halign: 'right', cellWidth: 80 },
        4: { halign: 'right', cellWidth: 80 },
      },
    })
    y = doc.lastAutoTable.finalY + 18
  })
  return y
}

// Dirección de servicio: viene exclusivamente de model.service_address
// (texto ya congelado), nunca se consulta nada actual del cliente.
// Instalación/Servicio: basta con que el texto histórico exista.
// Venta: además debe cumplirse requires_service === true (regla aprobada).
function shouldShowServiceAddress(model) {
  if (!model.service_address) return false
  if (model.quote_type === 'venta') return model.requires_service === true
  return model.quote_type === 'instalacion' || model.quote_type === 'servicio'
}
function serviceAddressLabel(model) {
  return model.quote_type === 'servicio' ? 'Lugar del servicio' : 'Dirección de servicio'
}

// Vencimiento: nunca la fecha actual. Fase 6.7C-1: si el modelo trae
// valid_until (PostgreSQL es la autoridad; en un PDF candidato, el valor que
// la publicación verifica contra la DB), se imprime ese valor tal cual, sin
// recalcular. Solo cuando no existe se usa el cálculo anterior
// (created_at + valid_days, en la zona horaria del navegador) — rama legacy.
// Si falta todo, no se inventa nada.
function computeVencimiento(model) {
  if (model.valid_until) return formatValidUntilForPdf(model.valid_until)
  if (!model.created_at || !model.valid_days) return null
  const d = new Date(model.created_at)
  d.setDate(d.getDate() + Number(model.valid_days))
  return d.toLocaleDateString('es-MX')
}

// rec: fila de `quotes` (o un objeto con la misma forma antes de insertarse)
// config: fila de `app_config`
// options (opcional, Fase 6.7C-1): { logoDataUrl, strictLogo } — ver
// resolveLogoDataUrl. strictLogo (Fase 6.7C-1.1): si hay logo que dibujar y
// no se puede incrustar, buildPdfDoc LANZA en vez de seguir sin él. Solo lo
// usa la publicación de revisiones; el camino legacy conserva el
// comportamiento tolerante de siempre.
export async function buildPdfDoc(rec, config, options) {
  const model = resolveDocumentModel(rec, config)
  const isReceipt = model.isReceipt
  // Layout especializado solo para cotizaciones (nunca recibos) con
  // quote_type conocido. Legacy (quote_type=null) y recibos conservan
  // exactamente el layout de 6.1 — sin badge, sin agrupación, sin unidad,
  // sin dirección de servicio, sin línea de vencimiento.
  const isSpecialized = !isReceipt && !!model.quote_type

  const doc = new jsPDF({ unit: 'pt', format: 'letter' })
  const marginX = MARGIN_X
  let y = 56
  let nameX = marginX

  const logoDataUrl = await resolveLogoDataUrl(model, options)
  if (logoDataUrl) {
    try {
      const imgFmt = logoDataUrl.indexOf('image/png') > -1 ? 'PNG' : 'JPEG'
      doc.addImage(logoDataUrl, imgFmt, marginX, 30, 34, 34)
      nameX = marginX + 44
    } catch (e) {
      // Camino legacy/tolerante: si el logo no se puede dibujar seguimos sin
      // él — el PDF nunca falla por esto. Modo estricto (publicación 6.7): un
      // logo declarado que no se incrusta NO se traga, porque el snapshot lo
      // referencia y el PDF publicado tiene que contenerlo de verdad.
      if (options && options.strictLogo) {
        throw new Error('No se pudo incrustar el logo en el PDF: ' + (e && e.message ? e.message : e))
      }
    }
  }

  doc.setFont('helvetica', 'bold'); doc.setFontSize(16)
  doc.text(model.company.company_name || 'Mi Empresa', nameX, y)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90, 100, 110)
  y += 16
  const infoLine = [model.company.phone, model.company.email, model.company.address].filter(Boolean).join('  ·  ')
  doc.text(infoLine, nameX, y)

  doc.setTextColor(20, 20, 20)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13)
  const title = isReceipt ? 'RECIBO' : (isSpecialized ? `COTIZACIÓN · ${QUOTE_TYPE_LABEL[model.quote_type]}` : 'COTIZACIÓN')
  doc.text(title, PAGE_RIGHT, 56, { align: 'right' })
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90, 100, 110)
  doc.text('Folio: ' + model.folio, PAGE_RIGHT, 72, { align: 'right' })
  // Fase 6.7C-1.2: zona horaria explícita — el mismo created_at imprime la misma
  // fecha sin importar la zona horaria del navegador (antes dependía de ella).
  doc.text('Fecha: ' + new Date(model.created_at || Date.now()).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' }), PAGE_RIGHT, 84, { align: 'right' })
  if (isReceipt && model.related_folio) {
    doc.text('Ref. cotización: ' + model.related_folio, PAGE_RIGHT, 96, { align: 'right' })
  } else {
    doc.text('Vigencia: ' + model.valid_days + ' días', PAGE_RIGHT, 96, { align: 'right' })
    if (isSpecialized) {
      const vencimiento = computeVencimiento(model)
      if (vencimiento) doc.text('Vence: ' + vencimiento, PAGE_RIGHT, 108, { align: 'right' })
    }
  }

  y = 122
  doc.setDrawColor(220, 220, 220); doc.line(marginX, y, PAGE_RIGHT, y)
  y += 20
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(20, 20, 20)
  doc.text('Cliente', marginX, y)
  y += 14

  doc.setFontSize(10); doc.setTextColor(60, 68, 76)
  doc.setFont('helvetica', 'bold')
  doc.text(model.client.name || '-', marginX, y)
  y += 15
  if (model.client.address) y = writeLabeledLine(doc, 'Dirección', model.client.address, marginX, y)
  if (model.client.phone) y = writeLabeledLine(doc, 'Teléfono', model.client.phone, marginX, y)
  if (model.client.email) y = writeLabeledLine(doc, 'Correo', model.client.email, marginX, y)

  if (isSpecialized && shouldShowServiceAddress(model)) {
    y += 6
    y = ensureSpace(doc, y, 30)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(20, 20, 20)
    doc.text(serviceAddressLabel(model), marginX, y)
    y += 14
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(60, 68, 76)
    doc.text(model.service_address, marginX, y)
    y += 6
  }

  y += 8
  let ty
  if (isSpecialized) {
    ty = drawGroupedItems(doc, model, y)
  } else {
    const body = model.items.map((it) => [
      it.name || '-',
      String(it.qty || 0),
      fmt(it.price || 0),
      fmt((it.price || 0) * (it.qty || 0)),
    ])
    autoTable(doc, {
      startY: y,
      head: [['Descripción', 'Cant.', 'Precio unit.', 'Importe']],
      body,
      margin: { left: marginX, right: 48 },
      styles: { fontSize: 9.5, cellPadding: 6, textColor: [40, 45, 50] },
      headStyles: { fillColor: [18, 24, 31], textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles: { 1: { halign: 'center', cellWidth: 50 }, 2: { halign: 'right', cellWidth: 90 }, 3: { halign: 'right', cellWidth: 90 } },
    })
    ty = doc.lastAutoTable.finalY + 18
  }

  const totalsX = 380
  // El bloque de totales se protege como una sola unidad — nunca se parte
  // entre subtotal/descuento/IVA/total en dos páginas distintas.
  const totalsLines = 1 + (model.discount > 0 ? 1 : 0) + (model.apply_iva ? 1 : 0) + 1
  ty = ensureSpace(doc, ty, totalsLines * 15 + 14)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(60, 68, 76)
  doc.text('Subtotal', totalsX, ty); doc.text(fmt(model.subtotal), PAGE_RIGHT, ty, { align: 'right' }); ty += 15
  if (model.discount > 0) { doc.text('Descuento', totalsX, ty); doc.text('-' + fmt(model.discount), PAGE_RIGHT, ty, { align: 'right' }); ty += 15 }
  if (model.apply_iva) { doc.text(`IVA (${model.iva_rate}%)`, totalsX, ty); doc.text(fmt(model.iva), PAGE_RIGHT, ty, { align: 'right' }); ty += 15 }
  doc.setDrawColor(220, 220, 220); doc.line(totalsX, ty, PAGE_RIGHT, ty); ty += 14
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(20, 20, 20)
  doc.text('Total', totalsX, ty); doc.text(fmt(model.total), PAGE_RIGHT, ty, { align: 'right' })

  // Tiempo estimado: Instalación/Servicio si existe; Venta nunca (aunque
  // exista accidentalmente un valor almacenado); legacy/recibo exactamente
  // como en 6.1 (existe y no es recibo).
  const showInstallTime = isSpecialized
    ? (model.install_time_value && (model.quote_type === 'instalacion' || model.quote_type === 'servicio'))
    : (model.install_time_value && !isReceipt)
  if (showInstallTime) {
    ty = ensureSpace(doc, ty, 35)
    ty += 22
    const unitLabel = model.install_time_unit === 'dias'
      ? (model.install_time_value == 1 ? 'día' : 'días')
      : (model.install_time_value == 1 ? 'hora' : 'horas')
    doc.setFontSize(10); doc.setTextColor(60, 68, 76)
    ty = writeLabeledLine(doc, 'Tiempo de instalación estimado', `${model.install_time_value} ${unitLabel}`, marginX, ty)
  }

  ty += 34
  if (model.notes) {
    ty = ensureSpace(doc, ty, 25)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(20, 20, 20)
    doc.text('Notas', marginX, ty); ty += 13
    doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 88, 96)
    ty = writeWrapped(doc, model.notes, marginX, ty, 516) + 14
  }

  if (isReceipt) {
    // El recibo ya no muestra datos de pago (el servicio ya se pagó);
    // solo la confirmación.
    ty = ensureSpace(doc, ty, 15)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(20, 20, 20)
    doc.text('Servicio contratado y pagado según lo indicado. Gracias por su confianza.', marginX, ty)
  } else {
    // La cotización sí muestra cómo pagar, por si el cliente decide contratar.
    ty = ensureSpace(doc, ty, 25)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(20, 20, 20)
    doc.text('Datos de pago', marginX, ty); ty += 13
    doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 88, 96)
    ty = writeWrapped(doc, model.company.bank_info || '', marginX, ty, 516) + 14

    ty = ensureSpace(doc, ty, 25)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(20, 20, 20)
    doc.text('Términos y condiciones', marginX, ty); ty += 13
    doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 88, 96)
    ty = writeWrapped(doc, model.company.terms || '', marginX, ty, 516)

    // Fase 6.2.1 — espacio físico de aceptación. Solo representación visual:
    // no se guarda firma, nombre, fecha ni estado de aceptación en ningún
    // lado. Exclusivo de cotizaciones especializadas (legacy y recibos no
    // se tocan) — va al final, después de Términos, porque representa la
    // aceptación del documento completo.
    if (isSpecialized) {
      const SIG_LINE_WIDTH = 220
      const SIG_TOP_GAP = 28
      const SIG_LINE_TO_LABEL_GAP = 14
      const SIG_BOTTOM_GAP = 10
      // Bloque indivisible: separación superior + línea + texto + separación
      // inferior se protegen juntos, nunca en dos páginas distintas.
      ty = ensureSpace(doc, ty, SIG_TOP_GAP + SIG_LINE_TO_LABEL_GAP + SIG_BOTTOM_GAP)
      ty += SIG_TOP_GAP
      doc.setDrawColor(120, 120, 120)
      doc.line(marginX, ty, marginX + SIG_LINE_WIDTH, ty)
      ty += SIG_LINE_TO_LABEL_GAP
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(80, 88, 96)
      doc.text('Nombre y firma de aceptación', marginX + SIG_LINE_WIDTH / 2, ty, { align: 'center' })
    }
  }

  return doc
}

// Fase 6.5 — "moderna" se define por la presencia real del snapshot de
// empresa (igual que pdfModel.js: rec.company_snapshot), nunca únicamente
// por `contracted` — así una cotización legacy contratada nunca queda
// atrapada por las reglas estrictas pensadas para el modelo moderno.
function isModernQuote(rec) {
  return !!rec.company_snapshot
}

// Decide de dónde debe salir el PDF que se le entrega al usuario al
// descargar un registro YA GUARDADO (Historial, ficha de cliente — nunca se
// usa en el guardado mismo, que ya tiene su propio Blob recién generado).
// Nunca escribe nada — es de solo lectura, seguro de llamar cualquier
// número de veces.
//
// Reglas (Fase 6.5, aprobadas):
// - Recibo: siempre regenera (los recibos no participan de este sistema).
// - Cotización moderna Y contratada ("frozen"): su PDF persistido es la
//   única fuente de verdad aceptable. Si no hay pdf_storage_path, o la
//   descarga falla, es una INCONSISTENCIA real (no se trata como legacy) y
//   se reporta como error — jamás se regenera silenciosamente, para no
//   inventar una fidelidad histórica que no existe.
// - Cualquier otro caso (precontrato moderno, legacy con o sin contratar):
//   si hay path y la descarga funciona, se usa; si no, se regenera con
//   buildPdfDoc — comportamiento tolerante, igual que siempre.
export async function resolveQuoteDownload(rec, config) {
  const filename = rec.folio + '.pdf'
  if (rec.status === 'recibo') {
    const doc = await buildPdfDoc(rec, config)
    return { ok: true, blob: doc.output('blob'), filename }
  }

  const frozenModern = isModernQuote(rec) && rec.contracted === true

  if (rec.pdf_storage_path) {
    const blob = await downloadPersistedPdf(rec.pdf_storage_path)
    if (blob) return { ok: true, blob, filename }
    if (frozenModern) {
      return {
        ok: false,
        message: 'No fue posible recuperar el PDF original de esta cotización contratada. No se generará una copia nueva para no reemplazar el archivo histórico.',
      }
    }
  } else if (frozenModern) {
    return { ok: false, message: 'Esta cotización contratada no tiene disponible su PDF histórico.' }
  }

  const doc = await buildPdfDoc(rec, config)
  return { ok: true, blob: doc.output('blob'), filename }
}

// Fase 6.5 — genera el PDF final de una cotización MODERNA y lo sube
// (upsert) a su ruta canónica, para usarse como paso obligatorio ANTES de
// contratar (nunca best-effort en ese momento — ver app/historial/page.js).
// No escribe `pdf_storage_path` en la DB: eso lo hace el llamador, como
// parte del mismo UPDATE que congela la cotización. Reutilizable tal cual
// para un futuro flujo de aceptación digital (Fase 6.5, punto 17).
export async function ensureQuotePdfPersisted(rec, config) {
  let doc
  try {
    doc = await buildPdfDoc(rec, config)
  } catch (e) {
    return { ok: false }
  }
  const blob = doc.output('blob')
  const path = getQuotePdfPath(rec.id)
  const up = await uploadQuotePdf(path, blob)
  if (!up.ok) return { ok: false }
  return { ok: true, path }
}
