// app/q/[token]/page.js — página pública de una cotización (Fase 6.7 / bloque 6). Única ruta sin sesión (ver lib/publicRoutes.js).
// Componente de servidor mínimo: no consulta datos ni registra nada; entrega el token y la pista ?v= al componente de cliente, que
// usa solo la API existente. Cabeceras no-store / noindex / no-referrer: next.config.ts (source /q/:path*) y metadatos de abajo.
import PublicQuote from './PublicQuote'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Cotización',
  robots: { index: false, follow: false, nocache: true, noarchive: true },
  referrer: 'no-referrer',
}

export default async function PublicQuotePage({ params, searchParams }) {
  const { token } = await params
  const sp = (await searchParams) || {}
  // Pista de versión (?v=): solo experiencia de usuario; la base decide con la revisión enviada. Se acota y se ignora si no es texto.
  const hint = typeof sp.v === 'string' ? sp.v.slice(0, 32) : ''
  return <PublicQuote token={String(token).slice(0, 128)} hint={hint} />
}
