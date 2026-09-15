// app/api/ml-scrape-debug/route.js
// TEMPORAL — solo para diagnosticar. Bórrala cuando terminemos.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export async function GET(request) {
  const url = new URL(request.url).searchParams.get('url')
  if (!url) return Response.json({ error: 'Pasa ?url=' }, { status: 400 })

  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': UA, 'Accept-Language': 'es-MX,es;q=0.9' },
  })
  const html = await res.text()

  const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
  const hasOgPrice = /product:price:amount/.test(html)
  const looksBlocked = /captcha|are you a human|verifica que no eres un robot|access denied|cloudflare/i.test(html)

  return Response.json({
    status: res.status,
    finalUrl: res.url,
    htmlLength: html.length,
    cantidad_bloques_json_ld: ldBlocks.length,
    tiene_meta_og_price: hasOgPrice,
    parece_pagina_de_bloqueo: looksBlocked,
    primeros_1500_caracteres: html.slice(0, 1500),
  })
}
