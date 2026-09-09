// components/Sidebar.js
'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

const ITEMS = [
  { href: '/cotizar', label: 'Nueva cotización' },
  { href: '/historial', label: 'Historial' },
  { href: '/catalogo', label: 'Catálogo y precios' },
  { href: '/configuracion', label: 'Configuración' },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  if (pathname === '/login') return null

  async function logout() {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  return (
    <div className="sidebar">
      <div className="brand">
        <div className="name">Cotizador</div>
        <div className="tag">SEG · DOMÓTICA</div>
      </div>
      {ITEMS.map((it) => (
        <Link key={it.href} href={it.href} className={`navitem ${pathname === it.href ? 'active' : ''}`}>
          {it.label}
        </Link>
      ))}
      <div className="navfoot">
        <button className="btn ghost small" style={{ width: '100%' }} onClick={logout}>Cerrar sesión</button>
      </div>
    </div>
  )
}
