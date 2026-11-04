// components/ActionMenu.js — menú «⋯» de acciones secundarias de un registro (N3-B, ronda Donnie).
// Escritorio y tablet: menú flotante anclado al botón. Móvil (≤767 px): hoja de acciones desde abajo con fondo atenuado (diseño aprobado en N1).
// Teclado: ↓/↑ abren y enfocan una opción; ↑/↓/Inicio/Fin se mueven; Esc cierra (o regresa del segundo paso) y devuelve el foco al botón; Tab cierra.
// Una opción puede tener `children` (segundo paso, p. ej. «Enviar a…» → Correo / WhatsApp); `onEnter` se llama al entrar a ese paso.
// Cierre por pulsación fuera: una capa de fondo (scrim) a pantalla completa RECIBE la pulsación completa (bajar y soltar) y recién entonces cierra el menú; así lo que
// haya debajo (botones, enlaces, filas) nunca la recibe. No se cierra al bajar el botón del ratón: eso dejaba pasar el «soltar» al elemento de debajo.
// No ejecuta nada por sí mismo: cada opción llama al manejador que le pasa quien lo usa (los mismos de siempre).
'use client'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import DonnieIcon from './DonnieIcon'

const ITEM_H = 46

export default function ActionMenu({ label, title, items, disabled, closeSignal = 0 }) {
  // Abierto = «abierto en la vista actual»: si cambia `closeSignal` (la página cambió de página, filtros, búsqueda o tamaño) el menú queda cerrado
  // por derivación, sin efectos, para que nunca siga asociado a un registro que ya no se muestra.
  const [openAt, setOpenAt] = useState(null)
  const open = openAt !== null && openAt === closeSignal
  const [view, setView] = useState(null) // clave de la opción cuyo segundo paso se muestra
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)
  const menuRef = useRef(null)
  const id = useId()
  const group = view ? items.find((i) => i.key === view) : null
  const shown = group ? group.children : items

  function openMenu() {
    if (disabled || !items.length || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const w = 250, h = (items.length + 1) * ITEM_H + 16
    const top = r.bottom + 6 + h > window.innerHeight - 8 ? Math.max(8, r.top - 6 - h) : r.bottom + 6
    setPos({ top, left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) })
    setView(null)
    setOpenAt(closeSignal)
  }
  function close(returnFocus = true) {
    setOpenAt(null)
    setView(null)
    if (returnFocus && btnRef.current) btnRef.current.focus()
  }

  // Foco en la primera opción al abrir y al cambiar de paso.
  useEffect(() => {
    if (!open) return
    const first = menuRef.current && menuRef.current.querySelector('[role="menuitem"]:not([disabled])')
    if (first) first.focus()
  }, [open, view])

  useEffect(() => {
    if (!open) return undefined
    const onAway = () => { setOpenAt(null); setView(null) }
    window.addEventListener('scroll', onAway, true)
    window.addEventListener('resize', onAway)
    return () => {
      window.removeEventListener('scroll', onAway, true)
      window.removeEventListener('resize', onAway)
    }
  }, [open])

  function onMenuKey(e) {
    const opts = [...menuRef.current.querySelectorAll('[role="menuitem"]:not([disabled])')]
    const i = opts.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); opts[(i + 1) % opts.length].focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); opts[(i - 1 + opts.length) % opts.length].focus() }
    else if (e.key === 'Home') { e.preventDefault(); opts[0].focus() }
    else if (e.key === 'End') { e.preventDefault(); opts[opts.length - 1].focus() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (view) setView(null); else close() }
    else if (e.key === 'Tab') close()
  }
  function onBtnKey(e) {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) { e.preventDefault(); openMenu() }
  }
  function choose(it) {
    if (it.children) { if (typeof it.onEnter === 'function') it.onEnter(); setView(it.key); return }
    close(true)
    it.onSelect()
  }

  return (
    <>
      <button
        ref={btnRef} type="button" className="dn-btn-icon" disabled={disabled}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={label}
        onClick={() => (open ? close(false) : openMenu())} onKeyDown={onBtnKey}
      >
        <DonnieIcon name="more" />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <>
          <div className="dn-amenu-scrim" data-testid="amenu-scrim" onClick={(e) => { e.preventDefault(); e.stopPropagation(); close(true) }} />
          <div ref={menuRef} id={id} role="menu" aria-label={group ? `${label}: ${group.label}` : label} className="dn-amenu" style={{ top: pos.top, left: pos.left }} onKeyDown={onMenuKey}>
            {title && <div className="dn-amenu-title">{title}</div>}
            {group && (
              <button type="button" role="menuitem" tabIndex={-1} className="dn-amenu-item dn-amenu-back" onClick={() => setView(null)}>
                <DonnieIcon name="left" />{group.label}
              </button>
            )}
            {shown.map((it) => (
              <button
                key={it.key} type="button" role="menuitem" tabIndex={-1} disabled={it.disabled}
                aria-haspopup={it.children ? 'menu' : undefined}
                className={`dn-amenu-item${it.danger ? ' dn-danger' : ''}`}
                onClick={() => choose(it)}
              >
                {it.label}
                {it.children && <DonnieIcon name="right" className="dn-amenu-more" />}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </>
  )
}
