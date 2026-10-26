// lib/quoteQr.js — matriz del código QR del enlace de aceptación. Se genera LOCALMENTE (qrcode-generator 2.0.4, MIT, sin dependencias):
// el enlace con el token nunca sale del navegador hacia ningún servicio externo.
import qrcode from 'qrcode-generator'

// Devuelve una matriz cuadrada de booleanos (true = módulo oscuro), sin zona de silencio (la dibuja el PDF). Corrección de errores
// «M» (≈15 %): robusta para impresión sin hacer el código innecesariamente denso. Lanza si el texto no cabe.
export function qrModules(text, level = 'M') {
  if (typeof text !== 'string' || text === '') throw new Error('qr: texto vacío')
  const qr = qrcode(0, level)          // 0 = versión automática
  qr.addData(text, 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  const rows = []
  for (let r = 0; r < n; r += 1) {
    const row = new Array(n)
    for (let c = 0; c < n; c += 1) row[c] = qr.isDark(r, c)
    rows.push(row)
  }
  return rows
}
