// app/api/google-oauth/debug/route.js
// TEMPORAL — solo para diagnosticar, sin pedir sesión para que sea fácil de
// visitar directo desde el navegador. Bórrala en cuanto terminemos.
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getValidAccessToken } from '@/lib/googleCalendar'

export async function GET() {
  const { data: rows } = await supabaseAdmin
    .from('google_calendar_credentials')
    .select('user_id, google_email, connected_at, expires_at')

  const results = []
  for (const row of rows || []) {
    let accessToken, tokenError, scopeInfo
    try { accessToken = await getValidAccessToken(row.user_id) }
    catch (e) { tokenError = e.message }

    if (accessToken) {
      const res = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${accessToken}`)
      scopeInfo = await res.json()
    }
    results.push({ google_email: row.google_email, connected_at: row.connected_at, tokenError, scope: scopeInfo?.scope, expires_in: scopeInfo?.expires_in })
  }

  return Response.json(results)
}
