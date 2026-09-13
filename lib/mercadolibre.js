// lib/mercadolibre.js — usar solo en el servidor (rutas app/api/**/route.js).
// Mercado Libre exige que las consultas a la API vengan con el access_token
// de una cuenta autorizada (ver lib/mlAuth.js) — ya no acepta consultas
// anónimas, ni siquiera para datos públicos como el precio.

function extractItemId(url) {
  const match = url.match(/([A-Z]{3})-?(\d{6,})/)
  if (!match) return null
  return `${match[1]}${match[2]}`
}

async function resolveRedirect(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' })
    return res.url || url
  } catch (e) {
    return url
  }
}

// Devuelve { itemId, title, price, currency, permalink, thumbnail, status }
export async function lookupProductByUrl(rawUrl, accessToken) {
  let url = rawUrl.trim()
  let itemId = extractItemId(url)

  if (!itemId) {
    url = await resolveRedirect(url)
    itemId = extractItemId(url)
  }
  if (!itemId) {
    throw new Error('No se pudo identificar el producto en esa URL de Mercado Libre. Copia el link directo de la página del producto.')
  }

  return fetchMLItem(itemId, accessToken)
}

export async function fetchMLItem(itemId, accessToken) {
  const res = await fetch(`https://api.mercadolibre.com/items/${itemId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('Mercado Libre rechazó la consulta (token vencido o sin permisos). Vuelve a conectar tu cuenta en Configuración.')
    }
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
    status: data.status,
  }
}
