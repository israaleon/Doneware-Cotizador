// app/api/cron/check-prices/route.js
// Vercel llama esta ruta una vez al día según vercel.json. Cuando Vercel es
// quien la dispara, manda automáticamente el header Authorization con el
// valor de tu variable de entorno CRON_SECRET — por eso basta con compararlo.
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { lookupProductByUrl } from '@/lib/mercadolibre'

export async function GET(request) {
  const authHeader = request.headers.get('authorization') || ''
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'No autorizado.' }, { status: 401 })
  }

  const { data: products, error } = await supabaseAdmin
    .from('tracked_products')
    .select('*')
    .eq('active', true)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  const results = []

  for (const product of products || []) {
    try {
      const item = await lookupProductByUrl(product.ml_url)
      const newPrice = item.price
      const oldPrice = product.current_price

      // Se registra en el historial en cada revisión (no solo cuando cambia),
      // así la gráfica muestra también los tramos en los que el precio se
      // mantuvo igual.
      await supabaseAdmin.from('price_history').insert({ product_id: product.id, price: newPrice })

      await supabaseAdmin
        .from('tracked_products')
        .update({ current_price: newPrice, last_checked_at: new Date().toISOString() })
        .eq('id', product.id)

      if (newPrice !== oldPrice) {
        const diffAmount = newPrice - oldPrice
        const diffPercent = oldPrice ? (diffAmount / oldPrice) * 100 : 0
        const type = diffAmount > 0 ? 'price_up' : 'price_down'
        const verbo = diffAmount > 0 ? 'subió' : 'bajó'
        await supabaseAdmin.from('price_notifications').insert({
          product_id: product.id,
          product_name: product.name,
          type,
          old_price: oldPrice,
          new_price: newPrice,
          diff_amount: diffAmount,
          diff_percent: diffPercent,
          message: `${product.name} ${verbo} de $${oldPrice} a $${newPrice} (${diffPercent > 0 ? '+' : ''}${diffPercent.toFixed(1)}%).`,
        })
      }

      results.push({ id: product.id, ok: true, oldPrice, newPrice })
    } catch (err) {
      // Si Mercado Libre bloqueó la consulta o cambió su formato, no se cae
      // todo el cron: se avisa con una notificación y se sigue con el resto.
      await supabaseAdmin.from('price_notifications').insert({
        product_id: product.id,
        product_name: product.name,
        type: 'error',
        message: `No se pudo revisar "${product.name}" hoy: ${err.message}`,
      })
      results.push({ id: product.id, ok: false, error: err.message })
    }
  }

  return Response.json({ checked: results.length, results })
}
