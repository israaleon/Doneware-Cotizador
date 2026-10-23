// app/api/public/quotes/[token]/accept/route.js — aceptación pública. Única operación que modifica; exige Origin, JSON, nonce y cupos.
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { handleAcceptQuote } from '@/lib/publicAcceptanceHandlers'
import { logPublic, methodNotAllowed } from '@/lib/publicAcceptance'

export const dynamic = 'force-dynamic'
export const maxDuration = 20

export async function POST(request, { params }) {
  const { token } = await params
  return handleAcceptQuote(request, token, { admin: supabaseAdmin, env: process.env, log: logPublic })
}

export function GET() { return methodNotAllowed('POST') }
export function PUT() { return methodNotAllowed('POST') }
export function PATCH() { return methodNotAllowed('POST') }
export function DELETE() { return methodNotAllowed('POST') }
