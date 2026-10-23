// lib/supabaseAdmin.js
// ⚠️ SOLO para usarse dentro de app/api/**/route.js (código de servidor).
// Nunca lo importes desde un componente 'use client'.
import { createClient } from '@supabase/supabase-js'
import { withoutKeyAsBearer } from './supabaseApiKey'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY // sin NEXT_PUBLIC_

if (!serviceRoleKey) {
  console.warn('Falta SUPABASE_SERVICE_ROLE_KEY en tus variables de entorno de servidor.')
}

// Con una clave legacy (JWT) no cambia nada. Con una secret key (sb_secret_…) la documentación oficial exige enviarla solo en `apikey`: el SDK
// la añadiría también como Bearer cuando no hay sesión de usuario; withoutKeyAsBearer lo evita (el access token de un usuario SÍ se conserva).
const keyFetch = withoutKeyAsBearer(serviceRoleKey)

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  ...(keyFetch ? { global: { fetch: keyFetch } } : {}),
})
