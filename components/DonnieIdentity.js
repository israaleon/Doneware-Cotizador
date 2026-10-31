// components/DonnieIdentity.js — N2 (ronda Donnie): nombre y logo de la empresa (configuración existente) y correo de la sesión, cargados UNA vez
// para todo el marco interno. Sin sesión (p. ej. /login) no consulta nada. Un fallo no rompe ninguna pantalla: el marco muestra una representación neutral.
'use client'
import { createContext, useContext, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { loadCompanyIdentity, loadSessionEmail } from '@/lib/companyIdentity'

// status: 'loading' | 'ready' | 'error'  (ready con name '' = la empresa aún no tiene nombre en Ajustes)
const IdentityContext = createContext({ status: 'loading', name: '', logoUrl: '', email: '' })
export const useIdentity = () => useContext(IdentityContext)

export function IdentityProvider({ enabled, children }) {
  const pathname = usePathname()
  const [state, setState] = useState({ status: 'loading', name: '', logoUrl: '', email: '' })
  // Un fallo se reintenta al cambiar de pantalla (la sesión pudo renovarse); una carga correcta no se repite.
  const retryKey = state.status === 'error' ? pathname : 'once'

  useEffect(() => {
    if (!enabled) return undefined
    let active = true
    Promise.all([loadCompanyIdentity(supabase), loadSessionEmail(supabase)]).then(([company, email]) => {
      if (!active) return
      setState(company.ok ? { status: 'ready', name: company.name, logoUrl: company.logoUrl, email } : { status: 'error', name: '', logoUrl: '', email })
    })
    return () => { active = false }
  }, [enabled, retryKey])

  return <IdentityContext.Provider value={state}>{children}</IdentityContext.Provider>
}
