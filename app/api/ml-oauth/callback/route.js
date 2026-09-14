// app/api/ml-oauth/callback/route.js
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export async function GET(request) {
  const reqUrl = new URL(request.url)
  const code = reqUrl.searchParams.get('code')
  const appUrl = process.env.APP_URL

  if (!code) {
    return Response.redirect(`${appUrl}/configuracion?ml=error`, 302)
  }

  // Mismo redirect_uri fijo que se mandó en /start — debe coincidir exacto.
  const redirectUri = `${appUrl}/api/ml-oauth/callback`
  const res = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  })
  const json = await res.json()
  if (!res.ok) {
    console.error('ML OAuth error:', json)
    return Response.redirect(`${appUrl}/configuracion?ml=error`, 302)
  }

  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString()
  await supabaseAdmin.from('ml_credentials').upsert({
    id: 1,
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: expiresAt,
    ml_user_id: String(json.user_id || ''),
    connected_at: new Date().toISOString(),
  })

  return Response.redirect(`${appUrl}/configuracion?ml=success`, 302)
}
