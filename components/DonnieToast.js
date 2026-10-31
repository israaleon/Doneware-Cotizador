// components/DonnieToast.js — aviso breve «Próximamente» para los módulos futuros (no navegan ni ejecutan nada).
// Cualquier parte del marco lo dispara con announceSoon('Nombre'); el componente se monta una sola vez (en el menú lateral).
'use client'
import { useEffect, useRef, useState } from 'react'

const EVENT = 'dn:soon'
export function announceSoon(label) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT, { detail: String(label || '') }))
}

export default function DonnieToast() {
  const [msg, setMsg] = useState('')
  const timer = useRef(0)
  useEffect(() => {
    const on = (e) => {
      setMsg(`«${e.detail}» · Próximamente. Aún no tiene pantalla ni acciones.`)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setMsg(''), 3000)
    }
    window.addEventListener(EVENT, on)
    return () => { window.removeEventListener(EVENT, on); clearTimeout(timer.current) }
  }, [])
  return <div className={`dn-toast${msg ? ' dn-toast-show' : ''}`} role="status" aria-live="polite">{msg}</div>
}
