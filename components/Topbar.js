// components/Topbar.js — barra superior del marco interno (escritorio y tablet): empresa (nombre y logo de Ajustes) a la izquierda y cuenta (avatar) a la derecha.
// En móvil el mismo CompanyChip y la cuenta viven en la barra superior de Sidebar.js. No se muestra en /login ni en la página pública.
'use client'
import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { isPublicQuotePath } from '@/lib/publicRoutes'
import { useIdentity } from './DonnieIdentity'
import DonnieIcon from './DonnieIcon'
import AccountMenu from './AccountMenu'

// Empresa tomada de la configuración existente. Sin nombre/logo configurados o con un fallo de carga NO se inventa nada: representación neutral.
export function CompanyChip({ compact = false }) {
  const { status, name, logoUrl } = useIdentity()
  const [brokenLogo, setBrokenLogo] = useState('') // URL del logo que falló al cargar
  if (status === 'loading') return <div className={`dn-company${compact ? ' dn-company-compact' : ''}`} aria-hidden="true"><span className="dn-logo dn-skeleton" /></div>
  const showLogo = status === 'ready' && logoUrl && brokenLogo !== logoUrl
  return (
    <div className={`dn-company${compact ? ' dn-company-compact' : ''}`} data-status={status}>
      <span className="dn-logo">
        {showLogo
          // eslint-disable-next-line @next/next/no-img-element -- URL pública de Storage guardada por Ajustes (tamaño y dominio no fijos); mismo criterio que Configuración
          ? <img src={logoUrl} alt="" onError={() => setBrokenLogo(logoUrl)} />
          : <DonnieIcon name="building" />}
      </span>
      {status === 'ready' && name && <span className="dn-company-name" title={name}>{name}</span>}
      {status === 'ready' && !name && <span className="dn-company-name dn-muted" title="Escribe el nombre de tu empresa en Ajustes">Empresa sin nombre</span>}
      {status === 'error' && <span className="dn-company-name dn-muted" title="No se pudo leer la configuración de la empresa">Empresa</span>}
    </div>
  )
}

export default function Topbar() {
  const pathname = usePathname()
  if (pathname === '/login' || isPublicQuotePath(pathname)) return null
  return (
    <div className="dn-topbar">
      <CompanyChip />
      <div className="dn-spacer" />
      <AccountMenu />
    </div>
  )
}
