// lib/supabaseApiKey.js — módulo PURO (sin imports, sin entorno, sin 'server-only'): formatos de clave de API de Supabase.
// Documentación oficial (Supabase, «API keys»): las claves nuevas (publishable «sb_publishable_…» y secret «sb_secret_…») NO son JWT y se
// envían en la cabecera `apikey`, no en `Authorization: Bearer`. Las claves legacy (JWT anon/service_role) siguen usando `apikey` y
// `Authorization: Bearer` con el mismo valor.
// Observado con @supabase/supabase-js 2.115.0 (instalado): para REST, Storage y Auth el SDK, si no hay sesión de usuario, envía también la
// clave nueva como Bearer (la opción omitApiKeyAsBearer solo está activa para Edge Functions). Este módulo evita ese Bearer para las
// claves nuevas y deja las legacy exactamente como están hoy.
// Nunca imprime ni devuelve la clave en mensajes: solo la coloca en cabeceras de salida.

// Misma regla que el SDK: solo publishable y secret son «claves nuevas»; sb_temp_… y cualquier otro formato conservan el Bearer.
export function isNewApiKey(key) {
  return typeof key === 'string' && (key.startsWith('sb_publishable_') || key.startsWith('sb_secret_'))
}

// Cabeceras de autenticación de la clave del proyecto (p. ej. para una petición REST/Storage hecha a mano).
export function apiKeyHeaders(key) {
  if (typeof key !== 'string' || !key) return {}
  return isNewApiKey(key) ? { apikey: key } : { apikey: key, Authorization: 'Bearer ' + key }
}

// Para createClient({ global: { fetch } }): con una clave nueva, quita `Authorization: Bearer <esa clave>` que el SDK añade cuando no hay
// sesión de usuario. Un Bearer distinto (el access token de un usuario, p. ej. auth.getUser(jwt)) NO se toca. Con una clave legacy (o ausente)
// devuelve undefined: el cliente queda con el fetch por omisión, sin ningún cambio de comportamiento.
export function withoutKeyAsBearer(key, baseFetch) {
  if (!isNewApiKey(key)) return undefined
  return async function fetchWithoutKeyAsBearer(input, init) {
    const f = baseFetch || fetch
    if (typeof input !== 'string' && !(input instanceof URL)) return f(input, init)
    const headers = new Headers(init && init.headers)
    if (headers.get('authorization') === 'Bearer ' + key) headers.delete('authorization')
    return f(input, { ...(init || {}), headers })
  }
}
