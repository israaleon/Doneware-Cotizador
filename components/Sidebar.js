// components/Sidebar.js
'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

const ITEMS = [
  { href: '/cotizar', label: 'Nueva cotización' },
  { href: '/historial', label: 'Historial' },
  { href: '/servicios', label: 'Servicios' },
  { href: '/clientes', label: 'Clientes' },
  { href: '/catalogo', label: 'Catálogo y precios' },
  { href: '/configuracion', label: 'Configuración' },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const [open, setOpen] = useState(false)

  // Cierra el drawer automáticamente al cambiar de pestaña.
  useEffect(() => { setOpen(false) }, [pathname])

  if (pathname === '/login') return null

  async function logout() {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  return (
    <>
      {/* Solo visible en móvil/tablet chico: barra con el botón de menú */}
      <div className="mobile-topbar">
        <button className="hamburger" onClick={() => setOpen(true)} aria-label="Abrir menú">☰</button>
        <div className="title">Cotizador</div>
      </div>

      {/* Fondo oscuro detrás del drawer; da clic para cerrarlo */}
      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} />}

      <div className={`sidebar ${open ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <div className="name">Cotizador</div>
          <div className="tag">SEG · DOMÓTICA</div>
        </div>
        <div className="navitems">
          {ITEMS.map((it) => (
            <Link key={it.href} href={it.href} className={`navitem ${pathname === it.href ? 'active' : ''}`}>
              {it.label}
            </Link>
          ))}
        </div>
        <div className="navfoot">
          <button className="btn ghost small" style={{ width: '100%' }} onClick={logout}>Cerrar sesión</button>
        </div>
      </div>
    </>
  )
}
