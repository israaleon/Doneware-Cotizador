// lib/pdf.js
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { fmt } from './calc'

async function loadImageAsDataUrl(url) {
  const res = await fetch(url)
  const blob = await res.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// Escribe "Etiqueta: " en negritas seguido del valor en texto normal,
// en la misma línea. Devuelve la posición y siguiente.
function writeLabeledLine(doc, label, value, x, y) {
  doc.setFont('helvetica', 'bold')
  doc.text(label + ': ', x, y)
  const labelWidth = doc.getTextWidth(label + ': ')
  doc.setFont('helvetica', 'normal')
  doc.text(String(value), x + labelWidth, y)
  return y + 13
}

// rec: fila de `quotes` (o un objeto con la misma forma antes de insertarse)
// config: fila de `app_config`
export async function buildPdfDoc(rec, config) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' })
  const isReceipt = rec.status === 'recibo'
  const marginX = 48
  let y = 56
  let nameX = marginX

  if (config.logo_url) {
    try {
      const dataUrl = await loadImageAsDataUrl(config.logo_url)
      const imgFmt = dataUrl.indexOf('image/png') > -1 ? 'PNG' : 'JPEG'
      doc.addImage(dataUrl, imgFmt, marginX, 30, 34, 34)
      nameX = marginX + 44
    } catch (e) {
      // si el logo no carga (CORS, red, etc.) seguimos sin él
    }
  }

  doc.setFont('helvetica', 'bold'); doc.setFontSize(16)
  doc.text(config.company_name || 'Mi Empresa', nameX, y)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90, 100, 110)
  y += 16
  const infoLine = [config.phone, config.email, config.address].filter(Boolean).join('  ·  ')
  doc.text(infoLine, nameX, y)

  doc.setTextColor(20, 20, 20)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13)
  doc.text(isReceipt ? 'RECIBO' : 'COTIZACIÓN', 564, 56, { align: 'right' })
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90, 100, 110)
  doc.text('Folio: ' + rec.folio, 564, 72, { align: 'right' })
  doc.text('Fecha: ' + new Date(rec.created_at || Date.now()).toLocaleDateString('es-MX'), 564, 84, { align: 'right' })
  if (isReceipt && rec.related_folio) doc.text('Ref. cotización: ' + rec.related_folio, 564, 96, { align: 'right' })
  else doc.text('Vigencia: ' + rec.valid_days + ' días', 564, 96, { align: 'right' })

  y = 122
  doc.setDrawColor(220, 220, 220); doc.line(marginX, y, 564, y)
  y += 20
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(20, 20, 20)
  doc.text('Cliente', marginX, y)
  y += 14

  doc.setFontSize(10); doc.setTextColor(60, 68, 76)
  doc.setFont('helvetica', 'bold')
  doc.text(rec.client_name || '-', marginX, y)
  y += 15
  if (rec.client_address) y = writeLabeledLine(doc, 'Dirección', rec.client_address, marginX, y)
  if (rec.client_phone) y = writeLabeledLine(doc, 'Teléfono', rec.client_phone, marginX, y)
  if (rec.client_email) y = writeLabeledLine(doc, 'Correo', rec.client_email, marginX, y)

  y += 8
  const body = (rec.items || []).map((it) => [
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

  let ty = doc.lastAutoTable.finalY + 18
  const totalsX = 380
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(60, 68, 76)
  doc.text('Subtotal', totalsX, ty); doc.text(fmt(rec.subtotal), 564, ty, { align: 'right' }); ty += 15
  if (rec.discount > 0) { doc.text('Descuento', totalsX, ty); doc.text('-' + fmt(rec.discount), 564, ty, { align: 'right' }); ty += 15 }
  if (rec.apply_iva) { doc.text(`IVA (${rec.iva_rate}%)`, totalsX, ty); doc.text(fmt(rec.iva), 564, ty, { align: 'right' }); ty += 15 }
  doc.setDrawColor(220, 220, 220); doc.line(totalsX, ty, 564, ty); ty += 14
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(20, 20, 20)
  doc.text('Total', totalsX, ty); doc.text(fmt(rec.total), 564, ty, { align: 'right' })

  if (rec.install_time_value && !isReceipt) {
    ty += 22
    const unitLabel = rec.install_time_unit === 'dias'
      ? (rec.install_time_value == 1 ? 'día' : 'días')
      : (rec.install_time_value == 1 ? 'hora' : 'horas')
    doc.setFontSize(10); doc.setTextColor(60, 68, 76)
    ty = writeLabeledLine(doc, 'Tiempo de instalación estimado', `${rec.install_time_value} ${unitLabel}`, marginX, ty)
  }

  ty += 34
  if (rec.notes) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(20, 20, 20)
    doc.text('Notas', marginX, ty); ty += 13
    doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 88, 96)
    ty = writeWrapped(doc, rec.notes, marginX, ty, 516) + 14
  }

  if (isReceipt) {
    // El recibo ya no muestra datos de pago (el servicio ya se pagó);
    // solo la confirmación.
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(20, 20, 20)
    doc.text('Servicio contratado y pagado según lo indicado. Gracias por su confianza.', marginX, ty)
  } else {
    // La cotización sí muestra cómo pagar, por si el cliente decide contratar.
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(20, 20, 20)
    doc.text('Datos de pago', marginX, ty); ty += 13
    doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 88, 96)
    ty = writeWrapped(doc, config.bank_info || '', marginX, ty, 516) + 14

    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(20, 20, 20)
    doc.text('Términos y condiciones', marginX, ty); ty += 13
    doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 88, 96)
    writeWrapped(doc, config.terms || '', marginX, ty, 516)
  }

  return doc
}

function writeWrapped(doc, text, x, y, maxWidth) {
  doc.setFontSize(9)
  const lines = doc.splitTextToSize(text, maxWidth)
  lines.forEach((line) => { doc.text(line, x, y); y += 12 })
  return y
}
