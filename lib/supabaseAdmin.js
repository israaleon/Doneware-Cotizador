// lib/supabaseAdmin.js
// ⚠️ SOLO para usarse dentro de app/api/**/route.js (código de servidor).
// Nunca lo importes desde un componente 'use client'.
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY // sin NEXT_PUBLIC_

if (!serviceRoleKey) {
  console.warn('Falta SUPABASE_SERVICE_ROLE_KEY en tus variables de entorno de servidor.')
}

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
