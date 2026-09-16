// app/api/google-oauth/callback/route.js
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { verifyState } from '@/lib/oauthState'

export async function GET(request) {
  const reqUrl = new URL(request.url)
  const code = reqUrl.searchParams.get('code')
  const state = reqUrl.searchParams.get('state')
  const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '')

  const userId = state ? verifyState(state) : null
  if (!code || !userId) {
    return Response.redirect(`${appUrl}/configuracion?google=error`, 302)
  }

  const redirectUri = `${appUrl}/api/google-oauth/callback`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  })
  const json = await res.json()
  if (!res.ok) {
    console.error('Google OAuth error:', json)
    return Response.redirect(`${appUrl}/configuracion?google=error`, 302)
  }

  // Correo de la cuenta conectada, solo para mostrarlo en la interfaz.
  let googleEmail = ''
  try {
    const meRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${json.access_token}` },
    })
    const me = await meRes.json()
    googleEmail = me.email || ''
  } catch (e) { /* no es crítico si esto falla */ }

  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString()

  // Con prompt=consent Google casi siempre reenvía el refresh_token, pero
  // por si acaso no lo hiciera en alguna reconexión, no lo pisamos con vacío.
  const { data: existing } = await supabaseAdmin.from('google_calendar_credentials').select('refresh_token').eq('user_id', userId).single()

  await supabaseAdmin.from('google_calendar_credentials').upsert({
    user_id: userId,
    access_token: json.access_token,
    refresh_token: json.refresh_token || existing?.refresh_token,
    expires_at: expiresAt,
    google_email: googleEmail,
    connected_at: new Date().toISOString(),
  })

  return Response.redirect(`${appUrl}/configuracion?google=success`, 302)
}
