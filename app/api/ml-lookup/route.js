// app/api/ml-lookup/route.js
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { lookupProductByUrl } from '@/lib/mercadolibre'

export async function POST(request) {
  try {
    const authHeader = request.headers.get('authorization') || ''
    const token = authHeader.replace('Bearer ', '')
    if (!token) return Response.json({ error: 'No autorizado.' }, { status: 401 })
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token)
    if (userError || !userData?.user) return Response.json({ error: 'Sesión inválida o expirada.' }, { status: 401 })

    const { url } = await request.json()
    if (!url) return Response.json({ error: 'Falta la URL.' }, { status: 400 })

    const product = await lookupProductByUrl(url)
    return Response.json(product)
  } catch (err) {
    return Response.json({ error: err.message || 'No se pudo consultar el producto.' }, { status: 400 })
  }
}
