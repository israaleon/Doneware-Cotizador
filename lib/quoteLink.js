// lib/quoteLink.js — piezas PURAS (sin Supabase, sin DOM) del enlace público de aceptación /q/{token}?v={código}.
// Fase 6.7 / bloque 6 — integración del enlace y el QR en la publicación, el PDF y las plantillas.
//
// El enlace es una CREDENCIAL CONFIDENCIAL: nunca se escribe en consola, mensajes de error ni resultados de las funciones; solo vive en
// el PDF publicado y, al pulsar «Enviar a», en el mensaje que arma el propio usuario. El origen sale SIEMPRE de configuración de
// compilación (NEXT_PUBLIC_QUOTE_LINK_ORIGIN), nunca de Host, cabeceras ni window.location.

export const TOKEN_RE = /^[0-9a-f]{64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

// Código de versión que imprime el PDF y compara la página (?v=): los 8 primeros hex de la revisión PUBLICADA (igual que revision_code
// de la API: left(content_revision::text, 8)). Solo minúsculas: es la misma forma que devuelve PostgreSQL.
export function revisionCode(revision) {
  if (typeof revision !== 'string' || !UUID_RE.test(revision)) return null
  return revision.slice(0, 8)
}

// El contrato de la página pública (app/q) compara ?v= contra el CÓDIGO CORTO de 8 hex que devuelve la API (revision_code); no admite el
// uuid completo (la página acota ?v= a 32 caracteres y la API solo expone el código). Por eso la ambigüedad se evita al ELEGIR la revisión:
// su código de 8 hex no puede coincidir con el de NINGUNA revisión conocida de la misma cotización (la vigente y todas las anteriores,
// consecutivas o no). Así un enlace antiguo (R1) nunca puede parecer vigente porque R3 comparta su código. Cada elemento de `known`
// puede ser un uuid de revisión o el nombre de un archivo de revisión («{uuid}.pdf», «{uuid}.logo»): solo importan sus 8 primeros hex.
const HEX8_PREFIX = /^[0-9a-f]{8}/i
export function knownRevisionCodes(known) {
  const list = known == null ? [] : typeof known === 'string' ? [known] : Array.from(known)
  const codes = new Set()
  for (const k of list) {
    if (typeof k === 'string' && HEX8_PREFIX.test(k)) codes.add(k.slice(0, 8).toLowerCase())
  }
  return codes
}

// La revisión nueva se elige de modo que su código de 8 hex NO coincida con el de ninguna revisión conocida (ver arriba). Si en
// `maxTries` intentos no hay candidato distinto → null y NO se publica. `generate` es inyectable para pruebas.
export function pickRevisionId(known, generate, maxTries = 8) {
  const taken = knownRevisionCodes(known)
  for (let i = 0; i < maxTries; i += 1) {
    const candidate = generate()
    const code = revisionCode(candidate)
    if (code && !taken.has(code)) return candidate
  }
  return null
}

// Origen del enlace: solo https (http únicamente a localhost fuera de producción), sin credenciales, sin ruta, sin query ni fragmento.
export function normalizeLinkOrigin(raw, { allowInsecureLocal = false } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'missing' }
  let u
  try { u = new URL(raw.trim()) } catch { return { ok: false, reason: 'invalid' } }
  const httpsOk = u.protocol === 'https:'
  const localHttpOk = allowInsecureLocal && u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)
  if (!httpsOk && !localHttpOk) return { ok: false, reason: 'insecure' }
  if (u.username || u.password) return { ok: false, reason: 'credentials' }
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return { ok: false, reason: 'not_an_origin' }
  return { ok: true, origin: u.origin }
}

// Lectura de la configuración de compilación. `process.env.NEXT_PUBLIC_*` se sustituye en el bundle de Next por su valor literal.
export function getConfiguredLinkOrigin() {
  const raw = process.env.NEXT_PUBLIC_QUOTE_LINK_ORIGIN
  return normalizeLinkOrigin(raw, { allowInsecureLocal: process.env.NODE_ENV !== 'production' })
}

export const LINK_ORIGIN_MESSAGE = 'No está configurado el origen de los enlaces de aceptación (NEXT_PUBLIC_QUOTE_LINK_ORIGIN, https): no se publicó nada.'

// Enlace completo para una revisión concreta. Valida token y revisión; no devuelve nunca el token por separado.
export function buildQuoteLink({ origin, token, revision }) {
  if (typeof origin !== 'string' || origin === '') return { ok: false, reason: 'origin' }
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { ok: false, reason: 'token' }
  const code = revisionCode(revision)
  if (!code) return { ok: false, reason: 'revision' }
  return { ok: true, url: `${origin}/q/${token}?v=${code}`, code }
}

// ¿Puede esta fila tener un enlace público? Cotización moderna, precontractual, publicada y con vigencia (condiciones de
// ensure_quote_acceptance_token más «publicada»: sin revisión no hay documento que aceptar). Recibos, contratadas, canceladas,
// legacy (sin company_snapshot) y sin publicar → no.
export function canHavePublicLink(rec) {
  return !!rec && rec.status === 'cotizacion' && rec.lifecycle_status === 'cotizacion'
    && !!rec.company_snapshot && !!rec.content_revision && !!rec.valid_until
}
