// lib/mlAuth.js — SOLO servidor.
import { supabaseAdmin } from './supabaseAdmin'

const ML_TOKEN_URL = 'https://api.mercadolibre.com/oauth/token'

export async function getValidAccessToken() {
  const { data: creds } = await supabaseAdmin.from('ml_credentials').select('*').eq('id', 1).single()

  if (!creds || !creds.refresh_token) {
    throw new Error('Todavía no conectaste tu cuenta de Mercado Libre. Ve a Configuración → "Conectar con Mercado Libre".')
  }

  // Si el token actual sigue vigente (con 60s de margen), se reutiliza.
  if (creds.access_token && creds.expires_at && Date.now() < new Date(creds.expires_at).getTime() - 60000) {
    return creds.access_token
  }

  // Si no, se refresca con el refresh_token guardado.
  const res = await fetch(ML_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: creds.refresh_token,
    }),
  })
  const json = await res.json()
  if (!res.ok) {
    throw new Error(
      'No se pudo refrescar el token de Mercado Libre (' + (json.error || res.status) + '). ' +
      'Es posible que tengas que volver a conectar tu cuenta en Configuración.'
    )
  }

  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString()
  await supabaseAdmin.from('ml_credentials').update({
    access_token: json.access_token,
    refresh_token: json.refresh_token, // ML manda uno nuevo en cada refresh; el anterior deja de servir
    expires_at: expiresAt,
  }).eq('id', 1)

  return json.access_token
}
