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
  // 1) Bloque JSON-LD (schema.org/Product) — Tu estrategia original optimizada
  const ldMatches = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1])
      const items = Array.isArray(data) ? data : [data]
      for (const item of items) {
        if (item['@type'] === 'Product' && item.offers) {
          // Soporte tanto para Offer individual como para AggregateOffer
          const offersObj = item.offers
          const price = offersObj.price || offersObj.lowPrice || (Array.isArray(offersObj) ? offersObj[0]?.price : null)
          
          if (price) {
            return {
              title: item.name,
              price: Number(price),
              currency: offersObj.priceCurrency || 'MXN',
              image: Array.isArray(item.image) ? item.image[0] : item.image,
              sku: item.sku,
            }
          }
        }
      }
    } catch (e) { /* bloque inválido, continúa */ }
  }

  // 2) NUEVO RESPALDO PRINCIPAL: Estado interno de Mercado Libre (__PRELOADED_STATE__)
  // ML guarda absolutamente toda la información del producto en este objeto global de JS.
  const stateMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});\n/) || html.match(/__PRELOADED_STATE__\s*=\s*({.*?});/)
  if (stateMatch) {
    try {
      const state = JSON.parse(stateMatch[1])
      // Buscamos dentro de la estructura de componentes de la página
      const components = state.components || {}
      
      // Intentar extraer del componente de precio
      const priceComponent = Object.values(components).find(c => c.type === 'price' || c.id === 'price')
      const trackComponent = Object.values(components).find(c => c.track?.melidata_context?.item_id)
      
      if (priceComponent?.v2_format?.amount || priceComponent?.amount) {
        const finalPrice = priceComponent.v2_format?.amount || priceComponent.amount
        return {
          title: state.seo?.title || 'Producto Mercado Libre',
          price: Number(finalPrice),
          currency: priceComponent.v2_format?.currency_id || 'MXN',
          image: state.seo?.image || '',
          sku: trackComponent?.track?.melidata_context?.item_id || ''
        }
      }
    } catch (e) { /* error parseando estado interno */ }
  }

  // 3) NUEVO RESPALDO SECUNDARIO: Extracción directa de las clases de precio nativas (HTML puro)
  // Si todo lo anterior falla, buscamos el valor numérico dentro de los contenedores estándar de precio.
  const priceUiMatch = html.match(/<meta\s+itemprop="price"\s+content="([\d.]+)"/) || 
                       html.match(/class="[^"]*ui-pdp-price__regular[^"]*"[^>]*>\s*<span[^>]*>[^<]*<\/span>\s*<span\s+class="andes-money-amount__amount">([\d.,]+)<\/span>/)
  
  if (priceUiMatch) {
    const rawPrice = priceUiMatch[1].replace(/[^0-9.]/g, '') // limpia comas si las hay
    const titleUi = html.match(/<h1\s+class="ui-pdp-title">([^<]+)<\/h1>/)
    return {
      title: titleUi ? titleUi[1].trim() : 'Producto',
      price: Number(rawPrice),
      currency: 'MXN',
      image: '',
    }
  }

  // 4) Respaldo original: etiquetas <meta> Open Graph
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
