// components/SendMenu.js
'use client'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Botón "Enviar a ▾" que despliega Correo/WhatsApp en un menú flotante.
// Se posiciona con las coordenadas reales del botón (getBoundingClientRect)
// y se pinta en un portal directo a <body>, así nunca queda atrapado ni
// recortado por el contenedor de la fila ni empuja nada hacia abajo.
export default function SendMenu({ onEmail, onWhatsapp, disabled }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setPos({ top: r.bottom + 6, left: r.right })
    }
    setOpen((o) => !o)
  }

  useEffect(() => {
    if (!open) return
    function handleOutside(e) {
      if (btnRef.current?.contains(e.target)) return
      if (e.target.closest?.('.send-menu-popover')) return
      setOpen(false)
    }
    function handleClose() { setOpen(false) }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('touchstart', handleOutside)
    window.addEventListener('scroll', handleClose, true)
    window.addEventListener('resize', handleClose)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('touchstart', handleOutside)
      window.removeEventListener('scroll', handleClose, true)
      window.removeEventListener('resize', handleClose)
    }
  }, [open])

  return (
    <>
      <button ref={btnRef} className="btn ghost small" disabled={disabled} onClick={toggle}>
        Enviar a ▾
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          className="send-menu-popover"
          style={{ top: pos.top, left: pos.left, transform: 'translateX(-100%)' }}
        >
          <button onClick={() => { setOpen(false); onEmail() }}>✉️ &nbsp;Correo</button>
          <button onClick={() => { setOpen(false); onWhatsapp() }}>💬 &nbsp;WhatsApp</button>
        </div>,
        document.body
      )}
    </>
  )
}
