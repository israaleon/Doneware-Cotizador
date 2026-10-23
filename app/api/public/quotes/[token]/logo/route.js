// app/api/public/quotes/[token]/logo/route.js — logo de la revisión abierta, servido desde una ruta interna validada (nunca una URL externa).
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { handleGetLogo, createStorageReader } from '@/lib/publicAcceptanceHandlers'
import { logPublic, methodNotAllowed } from '@/lib/publicAcceptance'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

export async function GET(request, { params }) {
  const { token } = await params
  const readObject = createStorageReader({ baseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY })
  return handleGetLogo(request, token, { admin: supabaseAdmin, readObject, env: process.env, log: logPublic })
}

export function POST() { return methodNotAllowed('GET') }
export function PUT() { return methodNotAllowed('GET') }
export function PATCH() { return methodNotAllowed('GET') }
export function DELETE() { return methodNotAllowed('GET') }
