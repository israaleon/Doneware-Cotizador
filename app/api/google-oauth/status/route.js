// app/api/google-oauth/status/route.js
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export async function GET(request) {
  const authHeader = request.headers.get('authorization') || ''
  const token = authHeader.replace('Bearer ', '')
  if (!token) return Response.json({ error: 'No autorizado.' }, { status: 401 })
  const { data: userData, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !userData?.user) return Response.json({ error: 'Sesión inválida.' }, { status: 401 })

  const { data: creds } = await supabaseAdmin
    .from('google_calendar_credentials')
    .select('google_email, connected_at')
    .eq('user_id', userData.user.id)
    .single()

  return Response.json({ connected: !!creds?.connected_at, googleEmail: creds?.google_email || null, connectedAt: creds?.connected_at || null })
}
