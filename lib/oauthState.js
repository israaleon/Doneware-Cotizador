// lib/oauthState.js — SOLO servidor.
// Cada persona del equipo conecta SU PROPIO Google Calendar, así que cuando
// Google nos regresa al callback necesitamos saber, de forma confiable, a
// cuál de nuestros usuarios pertenece ese "code". Para eso viajamos un
// "state" firmado (usuario + fecha de expiración + firma HMAC) — así nadie
// puede fabricar un state apuntando a la cuenta de otra persona.
import crypto from 'crypto'

const SECRET = process.env.APP_STATE_SECRET

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
}

export function createState(userId) {
  const expires = Date.now() + 10 * 60 * 1000 // 10 minutos para completar el flujo
  const payload = `${userId}.${expires}`
  const signature = sign(payload)
  return Buffer.from(`${payload}.${signature}`).toString('base64url')
}

export function verifyState(state) {
  try {
    const decoded = Buffer.from(state, 'base64url').toString('utf8')
    const [userId, expiresStr, signature] = decoded.split('.')
    const payload = `${userId}.${expiresStr}`
    if (sign(payload) !== signature) return null
    if (Date.now() > Number(expiresStr)) return null
    return userId
  } catch (e) {
    return null
  }
}
