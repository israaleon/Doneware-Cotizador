// app/api/ml-status/route.js
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export async function GET(request) {
  const authHeader = request.headers.get('authorization') || ''
  const token = authHeader.replace('Bearer ', '')
  if (!token) return Response.json({ error: 'No autorizado.' }, { status: 401 })
  const { data: userData, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !userData?.user) return Response.json({ error: 'Sesión inválida.' }, { status: 401 })

  const { data: creds } = await supabaseAdmin.from('ml_credentials').select('connected_at, ml_user_id').eq('id', 1).single()
  return Response.json({ connected: !!creds?.refresh_token, connectedAt: creds?.connected_at || null })
}
