// lib/mercadolibre.js — usar solo en el servidor (rutas app/api/**/route.js).
// Mercado Libre sí ofrece una API pública y gratuita para consultar un
// artículo por su ID (https://api.mercadolibre.com/items/{id}), a diferencia
// de Amazon. Por eso este módulo, a diferencia de un scraper, es estable:
// no depende de leer el HTML de la página, que cambia seguido.

// Busca un patrón tipo "MLM1234567890" o "MLM-1234567890" en la URL.
function extractItemId(url) {
  const match = url.match(/([A-Z]{3})-?(\d{6,})/)
  if (!match) return null
  return `${match[1]}${match[2]}`
}

// Los links cortos de "compartir" (mercadolibre.com/sec/xxxxx) no traen el
// ID en la URL — hay que seguir la redirección para llegar a la URL real.
async function resolveRedirect(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' })
    return res.url || url
  } catch (e) {
    return url
  }
}

// Devuelve { itemId, title, price, currency, permalink, thumbnail, status }
export async function lookupProductByUrl(rawUrl) {
  let url = rawUrl.trim()
  let itemId = extractItemId(url)

  if (!itemId) {
    url = await resolveRedirect(url)
    itemId = extractItemId(url)
  }
  if (!itemId) {
    throw new Error('No se pudo identificar el producto en esa URL de Mercado Libre. Copia el link directo de la página del producto.')
  }

  return fetchMLItem(itemId)
}

export async function fetchMLItem(itemId) {
  const res = await fetch(`https://api.mercadolibre.com/items/${itemId}`)
  if (!res.ok) {
    throw new Error(`Mercado Libre respondió ${res.status} para ${itemId} (¿el producto sigue publicado?).`)
  }
  const data = await res.json()
  if (data.error) throw new Error(data.message || 'Mercado Libre no encontró ese producto.')

  return {
    itemId: data.id,
    title: data.title,
    price: data.price,
    currency: data.currency_id,
    permalink: data.permalink,
    thumbnail: (data.thumbnail || '').replace('http://', 'https://'),
    status: data.status, // 'active' | 'paused' | 'closed'
  }
}
