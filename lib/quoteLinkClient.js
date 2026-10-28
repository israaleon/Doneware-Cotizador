// lib/quoteLinkClient.js — obtención del token (ensure_quote_acceptance_token) y del enlace público desde el navegador autenticado.
// Fase 6.7 / bloque 6. Nada aquí escribe el token o el enlace en consola ni en mensajes: los resultados solo llevan códigos genéricos.
import { supabase } from './supabaseClient'
import { TOKEN_RE, buildQuoteLink, canHavePublicLink, getConfiguredLinkOrigin } from './quoteLink'

// ensure es idempotente: devuelve SIEMPRE el mismo token de la cotización (lo crea la primera vez). Solo `authenticated`.
// Errores posibles de la base (SQLSTATE): AQ001 sin sesión · AQ002 no existe · AQ003 no precontractual · AQ004 no moderna · AQ005 sin vigencia ·
// AQ006 el enlace fue REVOCADO (P-TOKEN): nunca se regenera solo; hay que hacerlo de forma explícita («Gestionar enlace»).
export async function requestQuoteToken(quoteId) {
  if (!quoteId) return { ok: false, code: 'invalid_input' }
  try {
    const { data, error } = await supabase.rpc('ensure_quote_acceptance_token', { p_quote_id: quoteId })
    if (error) return { ok: false, code: typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : 'rpc_error' }
    if (typeof data !== 'string' || !TOKEN_RE.test(data)) return { ok: false, code: 'bad_response' }
    return { ok: true, token: data }
  } catch {
    return { ok: false, code: 'network' }
  }
}

// Texto para el usuario (sin datos sensibles) según el código de requestQuoteToken.
export function describeTokenFailure(code) {
  switch (code) {
    case 'AQ001': return 'la sesión expiró'
    case 'AQ003': return 'la cotización ya no es precontractual'
    case 'AQ004': return 'la cotización es anterior al modelo actual (sin snapshot de empresa)'
    case 'AQ005': return 'la cotización no tiene vigencia'
    case 'AQ006': return 'el enlace de aceptación de esta cotización fue revocado; no se regenera automáticamente'
    case 'network': return 'error de red'
    case 'bad_response': return 'respuesta inesperada de la base de datos'
    default: return 'la base de datos rechazó la solicitud'
  }
}

// Enlace de una cotización YA publicada (para la plantilla {link}). Resultado:
//   { ok: true, url }                        → hay enlace
//   { ok: false, reason: 'not_eligible' }    → antigua/legacy/sin publicar/contratada/recibo: no hay enlace (no es un error)
//   { ok: false, reason: 'origin' | 'token' | 'revision' } → no se pudo (sí es un fallo: el llamador lo avisa)
export async function resolveQuoteLink(rec) {
  if (!canHavePublicLink(rec)) return { ok: false, reason: 'not_eligible' }
  const origin = getConfiguredLinkOrigin()
  if (!origin.ok) return { ok: false, reason: 'origin' }
  const t = await requestQuoteToken(rec.id)
  if (!t.ok) return { ok: false, reason: 'token', code: t.code }
  const link = buildQuoteLink({ origin: origin.origin, token: t.token, revision: rec.content_revision })
  if (!link.ok) return { ok: false, reason: link.reason }
  return { ok: true, url: link.url }
}
