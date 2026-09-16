// app/api/google-oauth/init/route.js
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { createState } from '@/lib/oauthState'

export async function POST(request) {
  const authHeader = request.headers.get('authorization') || ''
  const token = authHeader.replace('Bearer ', '')
  if (!token) return Response.json({ error: 'No autorizado.' }, { status: 401 })
  const { data: userData, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !userData?.user) return Response.json({ error: 'Sesión inválida.' }, { status: 401 })

  const base = (process.env.APP_URL || '').replace(/\/+$/, '')
  const redirectUri = `${base}/api/google-oauth/callback`
  const state = createState(userData.user.id)

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email')
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent') // asegura que siempre regrese refresh_token
  authUrl.searchParams.set('state', state)

  return Response.json({ url: authUrl.toString() })
}
