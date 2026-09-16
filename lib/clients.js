// lib/clients.js
import { supabase } from './supabaseClient'

// Devuelve el id del cliente que corresponde a estos datos de contacto,
// reutilizando uno existente (por teléfono, o si no hay, por correo) en vez
// de crear uno nuevo cada vez que alguien vuelve a cotizar.
export async function findOrCreateClient({ name, phone, email, address }) {
  const cleanPhone = (phone || '').replace(/\D/g, '')
  const cleanEmail = (email || '').trim().toLowerCase()

  if (cleanPhone) {
    const { data } = await supabase.from('clients').select('id').eq('phone', cleanPhone).limit(1).single()
    if (data) return data.id
  } else if (cleanEmail) {
    const { data } = await supabase.from('clients').select('id').eq('email', cleanEmail).limit(1).single()
    if (data) return data.id
  }

  const { data: created, error } = await supabase.from('clients').insert({
    name: name || '',
    phone: cleanPhone,
    email: cleanEmail,
    address: address || '',
  }).select('id').single()

  if (error) return null // si falla, la cotización se guarda igual sin client_id
  return created.id
}

// Para el buscador de "cliente existente" en Nueva cotización.
export async function searchClients(text) {
  if (!text || text.trim().length < 2) return []
  const { data } = await supabase
    .from('clients')
    .select('*')
    .or(`name.ilike.%${text}%,phone.ilike.%${text}%`)
    .order('name')
    .limit(8)
  return data || []
}
