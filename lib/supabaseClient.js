// lib/supabaseClient.js
// Cliente único de Supabase que vas a importar desde cualquier página o componente:
//   import { supabase } from '@/lib/supabaseClient'
//
// Ejemplos de uso una vez que tengas tus tablas creadas (ver schema.sql):
//
//   Leer el catálogo:
//     const { data, error } = await supabase.from('catalog_items').select('*').order('name')
//
//   Agregar un producto:
//     await supabase.from('catalog_items').insert({ name, unit, price })
//
//   Guardar una cotización:
//     await supabase.from('quotes').insert({ folio, status: 'cotizacion', client_name, items, ... })
//
//   Subir el logo a Storage:
//     await supabase.storage.from('logos').upload('logo.png', file, { upsert: true })

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    'Faltan NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_ANON_KEY en tu .env.local'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
