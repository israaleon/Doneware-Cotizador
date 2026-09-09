// components/AuthGate.js
// Protección simple del lado del cliente: si no hay sesión de Supabase,
// manda a /login. Es la forma más rápida de arrancar; si más adelante
// quieres protección real a nivel de servidor (para que ni siquiera se
// descargue el HTML de las páginas sin sesión), migra a @supabase/ssr
// con un middleware.js — pero para un sistema interno de un solo equipo,
// esto es suficiente para empezar.
'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

export default function AuthGate({ children }) {
  const [checking, setChecking] = useState(true)
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
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
  }, [pathname, router])

  if (pathname === '/login') return children
  if (checking) return <div style={{ padding: 40 }}>Cargando…</div>
  return children
}
