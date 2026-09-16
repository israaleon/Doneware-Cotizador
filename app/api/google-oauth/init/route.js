// app/api/google-oauth/init/route.js
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { createState } from '@/lib/oauthState'

export async function POST(request) {
  try {
    const authHeader = request.headers.get('authorization') || ''
    const token = authHeader.replace('Bearer ', '')
    if (!token) return Response.json({ error: 'No autorizado.' }, { status: 401 })
    const { data: userData, error } = await supabaseAdmin.auth.getUser(token)
    if (error || !userData?.user) return Response.json({ error: 'Sesión inválida.' }, { status: 401 })

    if (!process.env.APP_URL) return Response.json({ error: 'Falta configurar APP_URL en el servidor.' }, { status: 500 })
    if (!process.env.APP_STATE_SECRET) return Response.json({ error: 'Falta configurar APP_STATE_SECRET en el servidor.' }, { status: 500 })
    if (!process.env.GOOGLE_CLIENT_ID) return Response.json({ error: 'Falta configurar GOOGLE_CLIENT_ID en el servidor.' }, { status: 500 })

    const base = process.env.APP_URL.replace(/\/+$/, '')
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
  } catch (err) {
    return Response.json({ error: err.message || 'Error inesperado armando la conexión con Google.' }, { status: 500 })
  }
}
