// components/ProductTabs.js
'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

const TABS = [
  { href: '/cotizador-productos', label: 'Productos' },
  { href: '/cotizador-productos/dashboard', label: 'Dashboard' },
  { href: '/cotizador-productos/notificaciones', label: 'Notificaciones' },
]

export default function ProductTabs() {
  const pathname = usePathname()
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    async function loadCount() {
      const { count } = await supabase
        .from('price_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('read', false)
      setUnread(count || 0)
    }
    loadCount()
  }, [pathname])

  return (
    <div className="product-tabs">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className={`product-tab ${pathname === t.href ? 'active' : ''}`}>
          {t.label}
          {t.href.endsWith('notificaciones') && unread > 0 && <span className="tab-badge">{unread}</span>}
        </Link>
      ))}
    </div>
  )
}
