// lib/supabaseAdmin.js
// ⚠️ SOLO para usarse dentro de app/api/**/route.js (código de servidor).
// Nunca lo importes desde un componente 'use client'.
//
// Se necesita aquí por una razón específica: el cron diario que revisa
// precios (app/api/cron/check-prices) no lo dispara ningún usuario con
// sesión iniciada — lo dispara Vercel en automático — así que no hay un
// token de sesión con el que Supabase pueda aplicar RLS. La service role
// key se salta RLS por completo, por eso el acceso a este endpoint está
// protegido aparte con CRON_SECRET (ver esa ruta).
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY // sin NEXT_PUBLIC_

if (!serviceRoleKey) {
  console.warn('Falta SUPABASE_SERVICE_ROLE_KEY en tus variables de entorno de servidor.')
}

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
