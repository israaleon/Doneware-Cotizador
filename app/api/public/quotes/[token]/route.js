// app/api/public/quotes/[token]/route.js — consulta pública de una cotización (solo lectura). El token es confidencial.
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { handleGetQuote } from '@/lib/publicAcceptanceHandlers'
import { logPublic, methodNotAllowed } from '@/lib/publicAcceptance'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

export async function GET(request, { params }) {
  const { token } = await params
  return handleGetQuote(request, token, { admin: supabaseAdmin, env: process.env, log: logPublic })
}

export function POST() { return methodNotAllowed('GET') }
export function PUT() { return methodNotAllowed('GET') }
export function PATCH() { return methodNotAllowed('GET') }
export function DELETE() { return methodNotAllowed('GET') }
