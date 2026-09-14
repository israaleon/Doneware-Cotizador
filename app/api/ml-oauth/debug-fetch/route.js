// app/api/ml-oauth/debug-fetch/route.js
// TEMPORAL — solo para diagnosticar, sin pedir sesión para que sea fácil de
// visitar directo desde el navegador. Bórrala en cuanto terminemos.
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getValidAccessToken } from '@/lib/mlAuth'

export async function GET(request) {
  const itemId = new URL(request.url).searchParams.get('itemId') || 'MLM41835913'

  const { data: creds, error: credsError } = await supabaseAdmin.from('ml_credentials').select('*').eq('id', 1).single()

  let mlToken = null
  let tokenError = null
  try {
    mlToken = await getValidAccessToken()
  } catch (e) {
    tokenError = e.message
  }

  let mlStatus = null
  let mlBody = null
  if (mlToken) {
    const res = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
      headers: { Authorization: `Bearer ${mlToken}` },
    })
    mlStatus = res.status
    try { mlBody = await res.json() } catch (e) { mlBody = await res.text() }
  }

  return Response.json({
    credenciales_guardadas: creds ? {
      tiene_access_token: !!creds.access_token,
      tiene_refresh_token: !!creds.refresh_token,
      expires_at: creds.expires_at,
      ml_user_id: creds.ml_user_id,
      access_token_muestra: creds.access_token ? `${creds.access_token.slice(0, 12)}...${creds.access_token.slice(-4)}` : null,
    } : null,
    credsError: credsError?.message || null,
    token_usado_muestra: mlToken ? `${mlToken.slice(0, 12)}...${mlToken.slice(-4)}` : null,
    tokenError,
    itemId,
    mlStatus,
    mlBody,
  })
}
