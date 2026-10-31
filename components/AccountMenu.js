// components/AccountMenu.js — avatar circular + menú de cuenta (escritorio, tablet y móvil).
// Perfil: hoy solo existe el correo de la sesión; no hay nombre ni foto, así que el avatar es una silueta neutral (nada ficticio).
// «Mi perfil» es un módulo próximo. Cerrar sesión conserva el comportamiento de siempre: signOut + /login.
'use client'
import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { useIdentity } from './DonnieIdentity'
import { announceSoon } from './DonnieToast'
import DonnieIcon from './DonnieIcon'
import { confirmDiscard } from '@/lib/unsavedGuard'

export default function AccountMenu() {
  const pathname = usePathname()
  const router = useRouter()
  const { email } = useIdentity()
  const [openFor, setOpenFor] = useState(null) // ruta en la que se abrió: al cambiar de pantalla se cierra solo
  const [busy, setBusy] = useState(false)
  const wrapRef = useRef(null)
  const open = openFor === pathname

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpenFor(null) }
    const onKey = (e) => { if (e.key === 'Escape') setOpenFor(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  async function logout() {
    if (busy) return
    if (!confirmDiscard()) return // cambios sin guardar en el Cotizador: no se cierra la sesión sin confirmar
    setBusy(true)
    await supabase.auth.signOut()
    router.replace('/login')
  }

  return (
    <div className="dn-account" ref={wrapRef}>
      <button type="button" className="dn-avatar" aria-haspopup="menu" aria-expanded={open} aria-label="Cuenta" onClick={() => setOpenFor(open ? null : pathname)}>
        <DonnieIcon name="user" />
      </button>
      {open && (
        <div className="dn-menu" role="menu">
          <div className="dn-who">
            <span className="dn-avatar dn-avatar-big" aria-hidden="true"><DonnieIcon name="user" /></span>
            <span className="dn-who-tx"><b>Sesión iniciada</b><small>{email || 'Correo no disponible'}</small></span>
          </div>
          <button type="button" role="menuitem" className="dn-menu-item dn-menu-soon" aria-disabled="true" onClick={() => announceSoon('Mi perfil')}>
            <DonnieIcon name="user" /><span>Mi perfil<small>Próximamente: nombre y foto de perfil</small></span>
          </button>
          <button type="button" role="menuitem" className="dn-menu-item" onClick={logout} disabled={busy}>
            <DonnieIcon name="logout" /><span>{busy ? 'Cerrando sesión…' : 'Cerrar sesión'}</span>
          </button>
        </div>
      )}
    </div>
  )
}
