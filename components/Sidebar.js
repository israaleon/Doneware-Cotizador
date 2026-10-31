// components/Sidebar.js — marco de navegación Donnie (N2). Una sola fuente de módulos (lib/donnieNav.js), tres presentaciones por CSS:
//   ≥1280 px: menú lateral completo por categorías · 768–1279 px: carril de iconos con título bajo cada icono ·
//   ≤767 px: barra superior + barra inferior de cuatro controles (Inicio, Cotizar, Ventas, Más) y hoja «Todos los módulos».
// Los módulos próximos se muestran identificados como tales, sin ruta ni acción. No se muestra en /login ni en la página pública /q/[token].
'use client'
import { useEffect, useState } from 'react'
import GuardedLink from './GuardedLink'
import { usePathname } from 'next/navigation'
import { isPublicQuotePath } from '@/lib/publicRoutes'
import { NAV_CATEGORIES, NAV_MODULES, modulesByCategory, moduleById, isModuleActive } from '@/lib/donnieNav'
import DonnieBrand from './DonnieBrand'
import DonnieIcon from './DonnieIcon'
import DonnieToast, { announceSoon } from './DonnieToast'
import AccountMenu from './AccountMenu'
import { CompanyChip } from './Topbar'

function NavItem({ mod, pathname }) {
  const lab = mod.label
  if (mod.state === 'soon') {
    return (
      <button type="button" className="dn-future" data-label={`${lab} · Próximamente`} aria-disabled="true" aria-label={`${lab}, próximamente`} onClick={() => announceSoon(lab)}>
        <DonnieIcon name={mod.icon} /><span className="dn-txt">{lab}</span><span className="dn-pill">Pronto</span>
      </button>
    )
  }
  const cur = isModuleActive(mod, pathname)
  return (
    <GuardedLink href={mod.href} className={`dn-link${cur ? ' dn-cur' : ''}`} aria-current={cur ? 'page' : undefined} data-label={lab}>
      <DonnieIcon name={mod.icon} /><span className="dn-txt">{lab}</span>
    </GuardedLink>
  )
}

function SheetItem({ mod }) {
  const lab = mod.label
  if (mod.state === 'soon') {
    return (
      <button type="button" className="dn-future" aria-disabled="true" aria-label={`${lab}, próximamente`} onClick={() => announceSoon(lab)}>
        <DonnieIcon name={mod.icon} /><span>{lab}<small>Próximamente</small></span>
      </button>
    )
  }
  return <GuardedLink href={mod.href}><DonnieIcon name={mod.icon} /><span>{lab}</span></GuardedLink>
}

export default function Sidebar() {
  const pathname = usePathname()
  const [sheetFor, setSheetFor] = useState(null) // ruta en la que se abrió la hoja: al cambiar de pantalla se cierra sola
  const [tip, setTip] = useState(null) // etiqueta del carril de tablet: { text, top, left }
  const sheetOpen = sheetFor === pathname

  useEffect(() => {
    if (!sheetOpen) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setSheetFor(null) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [sheetOpen])

  if (pathname === '/login' || isPublicQuotePath(pathname)) return null

  const showTip = (el) => {
    if (typeof innerWidth !== 'number' || innerWidth < 768 || innerWidth >= 1280) return // la etiqueta solo se usa en el carril de iconos
    const r = el.getBoundingClientRect()
    setTip({ text: el.dataset.label, top: r.top + r.height / 2, left: r.right + 10 })
  }
  const onOver = (e) => { const el = e.target.closest('[data-label]'); if (el) showTip(el); else setTip(null) }

  const inicio = moduleById('inicio')
  const ajustes = moduleById('ajustes')
  const inMore = !isModuleActive(inicio, pathname) && !isModuleActive(moduleById('cotizador'), pathname) // la página actual vive en «Más»

  return (
    <>
      {/* Escritorio y tablet */}
      <aside className="dn-side" onMouseOver={onOver} onMouseLeave={() => setTip(null)} onFocus={(e) => { const el = e.target.closest('[data-label]'); if (el) showTip(el) }} onBlur={() => setTip(null)}>
        <DonnieBrand />
        <nav aria-label="Módulos de Donnie" className="dn-nav">
          <div className="dn-group dn-first"><div className="dn-items"><NavItem mod={inicio} pathname={pathname} /></div></div>
          {NAV_CATEGORIES.map((cat) => (
            <div className="dn-group" key={cat}>
              <div className="dn-cat">{cat}</div>
              <div className="dn-items">{modulesByCategory(cat).map((m) => <NavItem key={m.id} mod={m} pathname={pathname} />)}</div>
            </div>
          ))}
        </nav>
        <div className="dn-group dn-bottom"><div className="dn-items"><NavItem mod={ajustes} pathname={pathname} /></div></div>
      </aside>
      {tip && <div className="dn-tip" role="presentation" style={{ top: tip.top, left: tip.left }}>{tip.text}</div>}

      {/* Móvil: barra superior */}
      <div className="dn-mtop">
        <div className="dn-mword" aria-label="Donnie">Donnie<i>.</i></div>
        <CompanyChip compact />
        <AccountMenu />
      </div>

      {/* Móvil: barra inferior de cuatro controles (icono pequeño + título; las áreas de pulsación conservan su tamaño) */}
      <nav className="dn-bottombar" aria-label="Navegación principal">
        <GuardedLink href="/" aria-current={isModuleActive(inicio, pathname) ? 'page' : undefined} aria-label="Inicio"><DonnieIcon name="home" /><span className="dn-lbl">Inicio</span></GuardedLink>
        <GuardedLink href="/cotizador" className="dn-cotizar" aria-current={isModuleActive(moduleById('cotizador'), pathname) ? 'page' : undefined} aria-label="Cotizar: nueva cotización o mis cotizaciones"><DonnieIcon name="plus" /><span className="dn-lbl">Cotizar</span></GuardedLink>
        <button type="button" className="dn-soon-ic" aria-disabled="true" aria-label="Ventas, próximamente" onClick={() => announceSoon('Ventas')}><DonnieIcon name="trend" /><span className="dn-lbl">Ventas</span><span className="dn-dotsoon" aria-hidden="true" /></button>
        <button type="button" className={inMore ? 'dn-in-more' : undefined} aria-haspopup="dialog" aria-expanded={sheetOpen} aria-label="Más módulos" onClick={() => setSheetFor(pathname)}><DonnieIcon name="grid" /><span className="dn-lbl">Más</span></button>
      </nav>

      {/* Móvil: hoja con todos los módulos por categoría */}
      {sheetOpen && <div className="dn-scrim" onClick={() => setSheetFor(null)} />}
      <div className={`dn-sheet${sheetOpen ? ' dn-sheet-open' : ''}`} role="dialog" aria-modal="true" aria-label="Todos los módulos" aria-hidden={!sheetOpen}>
        <div className="dn-grab" />
        <div className="dn-sheet-head"><div className="dn-sheet-title">Todos los módulos</div><button type="button" className="dn-sheet-close" aria-label="Cerrar" tabIndex={sheetOpen ? 0 : -1} onClick={() => setSheetFor(null)}><DonnieIcon name="close" /></button></div>
        {[...NAV_CATEGORIES, 'Ajustes'].map((cat) => (
          <div key={cat}><h3>{cat}</h3><div className="dn-sheet-grid">{NAV_MODULES.filter((m) => m.cat === cat).map((m) => <SheetItem key={m.id} mod={m} />)}</div></div>
        ))}
      </div>

      <DonnieToast />
    </>
  )
}
