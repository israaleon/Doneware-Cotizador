// lib/sendLink.js — decide qué enlace ({link}) lleva el mensaje de «Enviar a» (correo / WhatsApp). Sin React, sin Supabase: el resolvedor
// (resolveQuoteLink de lib/quoteLinkClient.js) y la confirmación se inyectan, para poder probarlo.
//
// Principios:
//  • Solo se pide el enlace si la plantilla usa {link} Y la cotización puede tenerlo (moderna, precontractual, publicada y vigente).
//  • El enlace se prepara al ABRIR el menú «Enviar a» (prefetch) para que, al elegir Correo/WhatsApp, el mensaje se arme en el mismo
//    gesto del clic (los celulares solo abren apps externas durante ese gesto). Si aún no está listo se espera; no se envía nada solo.
//  • Cotización que no puede tener enlace (antigua, legacy, sin publicar, contratada, recibo): NO es un error; la plantilla omite la
//    línea de {link} (lib/templates.js).
//  • Si PUEDE tenerlo pero no se obtuvo (red, sesión, origen sin configurar): se pregunta antes de abrir el mensaje SIN enlace; si el usuario
//    cancela no se abre nada. Nunca se envía un mensaje sin enlace en silencio.
//  • El enlace es confidencial: no se registra ni se incluye en los mensajes de error.
import { canHavePublicLink } from './quoteLink'
import { templatesUseLink } from './templates'

export const NO_LINK_CONFIRM = 'No se pudo obtener el enlace de aceptación de esta cotización. ¿Quieres abrir el mensaje SIN el enlace?'
// P-TOKEN: el enlace fue revocado (AQ006). No se regenera solo: se explica y se pregunta; nunca se envía sin enlace en silencio.
export const REVOKED_LINK_CONFIRM = 'El enlace de aceptación de esta cotización fue REVOCADO, así que el mensaje no puede llevar un enlace que funcione. Para generar uno nuevo usa «Gestionar enlace» (si la opción aún no aparece, la regeneración todavía no está habilitada). ¿Quieres abrir el mensaje SIN el enlace?'

export const createLinkCache = () => new Map()

// Una entrada por cotización Y revisión publicada: si se vuelve a publicar, se pide de nuevo (el enlace lleva ?v= de la revisión).
export const linkKey = (rec) => `${rec.id}:${rec.content_revision || ''}`

export function wantsLink(rec, templates) {
  return templatesUseLink(...templates) && canHavePublicLink(rec)
}

function start(cache, rec, resolver) {
  const key = linkKey(rec)
  const entry = { state: 'pending' }
  entry.promise = Promise.resolve()
    .then(() => resolver(rec))
    .then((r) => { entry.state = r && r.ok ? 'ready' : 'failed'; entry.url = r && r.ok ? r.url : null; entry.code = r && !r.ok && typeof r.code === 'string' ? r.code : null })
    .catch(() => { entry.state = 'failed'; entry.url = null; entry.code = null })
  cache.set(key, entry)
  return entry
}

// Se llama al abrir el menú. No devuelve nada; no lanza.
export function prefetchLink({ cache, rec, templates, resolver }) {
  if (!wantsLink(rec, templates)) return
  const cur = cache.get(linkKey(rec))
  if (cur && cur.state !== 'failed') return
  start(cache, rec, resolver)
}

// Devuelve: string (enlace, o '' si no corresponde) | false (el usuario canceló) — de forma SÍNCRONA si ya se sabe; si no, una Promesa.
export function linkForSend({ cache, rec, templates, resolver, confirm }) {
  if (!wantsLink(rec, templates)) return ''
  let entry = cache.get(linkKey(rec))
  const finish = (e) => {
    if (e.state === 'ready' && e.url) return e.url
    return confirm(e.code === 'AQ006' ? REVOKED_LINK_CONFIRM : NO_LINK_CONFIRM) ? '' : false
  }
  if (entry && entry.state !== 'pending') return finish(entry)
  if (!entry) entry = start(cache, rec, resolver)
  return entry.promise.then(() => finish(entry))
}
