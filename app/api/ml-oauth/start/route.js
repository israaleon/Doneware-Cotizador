// app/api/ml-oauth/start/route.js
// El redirect_uri va fijo desde una variable de entorno (APP_URL), no se
// calcula del dominio desde el que entraste — Mercado Libre exige que sea
// EXACTAMENTE igual, carácter por carácter, al que registraste en el
// DevCenter, y calcularlo dinámicamente puede variar entre un dominio de
// preview de Vercel y tu dominio real de producción.
export async function GET() {
  if (!process.env.APP_URL) {
    return new Response('Falta configurar la variable de entorno APP_URL.', { status: 500 })
  }
  const base = process.env.APP_URL.replace(/\/+$/, '') // quita cualquier "/" sobrante al final
  const redirectUri = `${base}/api/ml-oauth/callback`
  const authUrl = new URL('https://auth.mercadolibre.com.mx/authorization')
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', process.env.ML_CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', 'offline_access read')
  return Response.redirect(authUrl.toString(), 302)
}
