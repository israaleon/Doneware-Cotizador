// lib/companyIdentity.js — N2 (ronda Donnie): nombre y logo de la empresa para el marco, leídos de la configuración EXISTENTE (app_config, fila 1).
// Solo lectura, de las columnas company_name y logo_url. Nunca lanza: devuelve { ok:false } y el marco muestra una representación neutral.
// No inventa nombre ni logo: si falta alguno, el marco lo dice (sin datos) en vez de poner uno de muestra.

const MAX_NAME = 80

export function cleanCompanyName(v) {
  return typeof v === 'string' ? v.trim().slice(0, MAX_NAME) : ''
}

// El logo es una URL pública de Storage guardada por Ajustes; solo se acepta http(s).
export function cleanLogoUrl(v) {
  if (typeof v !== 'string' || !v.trim()) return ''
  try {
    const u = new URL(v.trim())
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : ''
  } catch {
    return ''
  }
}

// client = cliente de supabase-js.
//   { ok: true, name, logoUrl }  (name/logoUrl pueden venir vacíos: la empresa aún no los configuró)  |  { ok: false }
export async function loadCompanyIdentity(client) {
  try {
    const { data, error } = await client.from('app_config').select('id, company_name, logo_url').eq('id', 1).single()
    if (error || !data || typeof data !== 'object' || Array.isArray(data) || Number(data.id) !== 1) return { ok: false }
    return { ok: true, name: cleanCompanyName(data.company_name), logoUrl: cleanLogoUrl(data.logo_url) }
  } catch {
    return { ok: false }
  }
}

// Correo de la sesión actual (único dato de perfil que existe hoy). Nunca lanza.
export async function loadSessionEmail(client) {
  try {
    const { data } = await client.auth.getSession()
    const email = data && data.session && data.session.user && data.session.user.email
    return typeof email === 'string' ? email.slice(0, 120) : ''
  } catch {
    return ''
  }
}
