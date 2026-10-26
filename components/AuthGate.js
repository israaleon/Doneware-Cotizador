// components/AuthGate.js
// Protección simple del lado del cliente: si no hay sesión de Supabase,
// manda a /login. Es la forma más rápida de arrancar; si más adelante
// quieres protección real a nivel de servidor (para que ni siquiera se
// descargue el HTML de las páginas sin sesión), migra a @supabase/ssr
// con un middleware.js — pero para un sistema interno de un solo equipo,
// esto es suficiente para empezar.
//
// Excepción acotada (Fase 6.7 / bloque 6): /q/{token} (página pública de una cotización) no requiere sesión, no consulta la sesión
// de Supabase y no se pinta dentro del marco interno (menú lateral). Solo esa forma de ruta: ver lib/publicRoutes.js.
'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { isPublicQuotePath } from '@/lib/publicRoutes'

export default function AuthGate({ sidebar, children }) {
  const [checking, setChecking] = useState(true)
  const router = useRouter()
  const pathname = usePathname()
  const isPublic = isPublicQuotePath(pathname)

  useEffect(() => {
    if (isPublic) return undefined
    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      if (!data.session && pathname !== '/login') {
        router.replace('/login')
      } else {
        setChecking(false)
      }
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session && pathname !== '/login') router.replace('/login')
    })
    return () => { active = false; listener.subscription.unsubscribe() }
  }, [pathname, router, isPublic])

  if (isPublic) return children

  // Marco interno: idéntico al que antes vivía en app/layout.js.
  const shell = (
    <div className="app-shell">
      {sidebar}
      <div className="main">{children}</div>
    </div>
  )
  if (pathname === '/login') return shell
  if (checking) return <div style={{ padding: 40 }}>Cargando…</div>
  return shell
}
