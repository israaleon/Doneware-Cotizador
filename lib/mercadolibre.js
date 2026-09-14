// lib/mercadolibre.js — usar solo en el servidor (rutas app/api/**/route.js).
//
// Ya no usa la API oficial de Mercado Libre: esa API ahora exige permisos de
// vendedor que solo aplican a TUS propias publicaciones, no a productos de
// otros vendedores. En su lugar, esto abre la misma página pública del
// producto que ves en el navegador y lee el precio de ahí.
//
// Es scraping, no un endpoint oficial: no está garantizado por Mercado Libre
// y se puede romper si cambian el formato de su página. Para hacerlo más
// resistente, primero intenta leer el bloque de datos estructurados
// (JSON-LD, tipo schema.org/Product) que casi todo sitio de e-commerce
// incluye para que Google lo lea — y solo si eso falla, cae a leer las
// etiquetas <meta> de vista previa (Open Graph).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function extractItemId(url) {
  const match = url.match(/([A-Z]{3})-?(\d{6,})/)
  return match ? `${match[1]}${match[2]}` : null
}

function parsePriceFromHtml(html) {
  // 1) Bloque JSON-LD (schema.org/Product) — la fuente más confiable.
  const ldMatches = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1])
      const items = Array.isArray(data) ? data : [data]
      for (const item of items) {
        if (item['@type'] === 'Product' && item.offers) {
          const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers
          if (offer?.price) {
            return {
              title: item.name,
              price: Number(offer.price),
              currency: offer.priceCurrency || 'MXN',
              image: Array.isArray(item.image) ? item.image[0] : item.image,
              sku: item.sku,
            }
          }
        }
      }
    } catch (e) { /* este bloque no era JSON válido; seguimos con el siguiente */ }
  }

  // 2) Respaldo: etiquetas <meta> de vista previa (Open Graph / product:price)
  const priceMeta =
    html.match(/<meta[^>]+property="product:price:amount"[^>]+content="([\d.]+)"/) ||
    html.match(/<meta[^>]+content="([\d.]+)"[^>]+property="product:price:amount"/)
  const titleMeta = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/)
  const imageMeta = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]*)"/)
  if (priceMeta) {
    return {
      title: titleMeta ? titleMeta[1] : 'Producto',
      price: Number(priceMeta[1]),
      currency: 'MXN',
      image: imageMeta ? imageMeta[1] : '',
    }
  }

  return null
}

// Devuelve { itemId, title, price, currency, permalink, thumbnail, status }
export async function lookupProductByUrl(rawUrl) {
  const res = await fetch(rawUrl.trim(), {
    redirect: 'follow',
    headers: { 'User-Agent': UA, 'Accept-Language': 'es-MX,es;q=0.9' },
  })
  const finalUrl = res.url || rawUrl

  if (!res.ok) {
    throw new Error(`No se pudo abrir la página (status ${res.status}). Mercado Libre pudo haber bloqueado la consulta automática.`)
  }

  const html = await res.text()
  const parsed = parsePriceFromHtml(html)
  if (!parsed) {
    throw new Error('No se pudo encontrar el precio en esa página. Mercado Libre pudo haber cambiado su formato, o está bloqueando la consulta automática.')
  }

  return {
    itemId: extractItemId(finalUrl) || parsed.sku || finalUrl,
    title: parsed.title,
    price: parsed.price,
    currency: parsed.currency,
    permalink: finalUrl,
    thumbnail: (parsed.image || '').replace('http://', 'https://'),
    status: 'active',
  }
}
