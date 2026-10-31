// components/GuardedLink.js — enlace del marco que, si el Cotizador tiene cambios sin guardar y el destino descartaría el formulario,
// pide confirmación antes de navegar (lib/unsavedGuard.js). Abrir en pestaña nueva o ir a la misma pantalla no descarta nada y no pregunta.
'use client'
import Link from 'next/link'
import { confirmDiscard, navigationWouldDiscard } from '@/lib/unsavedGuard'

export default function GuardedLink({ href, onClick, target, ...props }) {
  function handleClick(e) {
    if (onClick) onClick(e)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || target === '_blank') return
    const here = window.location.pathname + window.location.search
    if (!navigationWouldDiscard(here, href)) return
    if (!confirmDiscard()) e.preventDefault()
  }
  return <Link href={href} target={target} onClick={handleClick} {...props} />
}
