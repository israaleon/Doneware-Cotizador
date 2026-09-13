// app/api/ml-oauth/start/route.js
export async function GET(request) {
  const origin = new URL(request.url).origin
  const redirectUri = `${origin}/api/ml-oauth/callback`
  const authUrl = new URL('https://auth.mercadolibre.com.mx/authorization')
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', process.env.ML_CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  return Response.redirect(authUrl.toString(), 302)
}
