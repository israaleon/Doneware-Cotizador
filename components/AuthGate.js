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
import { IdentityProvider } from '@/components/DonnieIdentity'

export default function AuthGate({ sidebar, topbar, children }) {
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

  // Marco interno (N2, ronda Donnie): menú lateral + barra superior + contenido. La identidad de la empresa se carga una sola vez y solo con sesión (no en /login).
  const shell = (
    <IdentityProvider key={pathname === '/login' ? 'login' : 'app'} enabled={pathname !== '/login'}>
      <div className="dn-shell">
        {sidebar}
        <div className="main">
          {topbar}
          {children}
        </div>
      </div>
    </IdentityProvider>
  )
  if (pathname === '/login') return shell
  if (checking) return <div style={{ padding: 40 }}>Cargando…</div>
  return shell
}
