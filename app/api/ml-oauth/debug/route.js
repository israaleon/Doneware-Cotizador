// app/api/ml-oauth/debug/route.js
// TEMPORAL — solo para verificar que APP_URL y el redirect_uri calculado
// sean correctos. Bórrala cuando termines de diagnosticar (no expone nada
// sensible, pero no hay razón para dejarla).
export async function GET() {
  const raw = process.env.APP_URL || '(no está definida)'
  const base = raw.replace(/\/+$/, '')
  const redirectUri = `${base}/api/ml-oauth/callback`
  return Response.json({
    APP_URL_tal_cual_en_vercel: raw,
    APP_URL_sin_slash_final: base,
    redirect_uri_que_se_manda_a_mercadolibre: redirectUri,
    ML_CLIENT_ID: process.env.ML_CLIENT_ID || '(no está definida)',
  })
}
