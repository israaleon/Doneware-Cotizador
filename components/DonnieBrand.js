// components/DonnieBrand.js — marca «Donnie.» del menú lateral, con su animación de escritorio.
//
// Animación (solo escritorio ≥1280 px con mouse y SIN «movimiento reducido»): al entrar el mouse, el punto naranja (el mismo «.» de la marca) viaja
// del final de la palabra al punto de la «i» y se queda ahí; «Donnie» hace una gelatina breve, una sola vez por entrada. Al salir, el punto regresa.
// - El destino se mide con las métricas reales de la tipografía en uso (canvas), sin coordenadas fijas.
// - La «i» pierde su propio punto solo mientras el naranja está sobre ella o a punto de estarlo (se pinta «ı» sin punto): nunca se ven dos puntos.
// - Solo se usa `transform`: la marca no cambia de tamaño ni de posición. Si se entra y sale rápido, la gelatina no se reinicia ni se acumula.
// - Con movimiento reducido (o sin mouse) la marca queda estática. En tablet (carril) solo se muestra «D.» y en móvil la marca es estática.
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

const MOTION_QUERY = '(min-width:1280px) and (hover:hover) and (prefers-reduced-motion:no-preference)'
const motionOK = () => typeof matchMedia === 'function' && matchMedia(MOTION_QUERY).matches

export default function DonnieBrand() {
  const brandRef = useRef(null)
  const jellyRef = useRef(null)
  const giRef = useRef(null)
  const dtRef = useRef(null)
  const targetRef = useRef(null)
  const rafRef = useRef(0)
  const untilRef = useRef(0)
  const dotlessRef = useRef(false)
  const [dotless, setDotless] = useState(false)

  const measureTarget = useCallback(() => {
    const jelly = jellyRef.current, gi = giRef.current, dt = dtRef.current, brand = brandRef.current
    if (!jelly || !gi || !dt || !brand) return null
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return null
    const cs = getComputedStyle(jelly)
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const mi = ctx.measureText('i'), md = ctx.measureText('.'), ml = ctx.measureText('ı')
    const cx = (m) => (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2
    // Sin «ı» propia en la tipografía, la «i» conserva su punto y el naranja lo cubre (un poco más grande): sigue sin verse doble.
    const canSwap = Math.abs(ml.width - mi.width) < 0.01 && ml.actualBoundingBoxAscent < mi.actualBoundingBoxAscent - 1
    const t = {
      dx: gi.offsetLeft + cx(mi) - (dt.offsetLeft + cx(md)),
      dy: -(mi.actualBoundingBoxAscent - md.actualBoundingBoxAscent),
      r: Math.max(2.5, (md.actualBoundingBoxAscent + md.actualBoundingBoxDescent) / 2),
      canSwap,
    }
    brand.style.setProperty('--dn-dx', t.dx.toFixed(2) + 'px')
    brand.style.setProperty('--dn-dy', t.dy.toFixed(2) + 'px')
    brand.style.setProperty('--dn-cover', canSwap ? '1' : '1.3')
    targetRef.current = t
    return t
  }, [])

  const syncGlyph = useCallback(() => {
    const t = targetRef.current, dt = dtRef.current
    if (!t || !dt || !t.canSwap) return
    const m = new DOMMatrix(getComputedStyle(dt).transform)
    const near = Math.hypot(m.e - t.dx, m.f - t.dy) < t.r * 2.2
    if (near !== dotlessRef.current) { dotlessRef.current = near; setDotless(near) }
  }, [])

  const watch = useCallback(() => {
    untilRef.current = performance.now() + 900
    if (rafRef.current) return
    const tick = () => {
      syncGlyph()
      rafRef.current = performance.now() < untilRef.current ? requestAnimationFrame(tick) : 0
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [syncGlyph])

  const onEnter = useCallback(() => {
    if (!motionOK()) return
    measureTarget()
    brandRef.current.classList.add('dn-hot')
    const jelly = jellyRef.current
    if (!jelly.classList.contains('dn-jel')) jelly.classList.add('dn-jel') // si ya corre, no se reinicia ni se acumula
    watch()
  }, [measureTarget, watch])

  const onLeave = useCallback(() => {
    if (!brandRef.current) return
    brandRef.current.classList.remove('dn-hot')
    watch()
  }, [watch])

  // Si la ventana deja de cumplir las condiciones (se achica, cambia la preferencia), la marca vuelve a su estado estático.
  useEffect(() => {
    const reset = () => {
      if (motionOK()) return
      if (brandRef.current) brandRef.current.classList.remove('dn-hot')
      if (jellyRef.current) jellyRef.current.classList.remove('dn-jel')
      dotlessRef.current = false
      setDotless(false)
    }
    window.addEventListener('resize', reset)
    return () => {
      window.removeEventListener('resize', reset)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return (
    <div className="dn-brand" ref={brandRef} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="dn-word">
        <span className="dn-sr">Donnie</span>
        <span className="dn-jelly" ref={jellyRef} aria-hidden="true" onAnimationEnd={(e) => e.currentTarget.classList.remove('dn-jel')}>
          D<span className="dn-rest">onn<span ref={giRef}>{dotless ? 'ı' : 'i'}</span>e</span><i className="dn-dot" ref={dtRef}>.</i>
        </span>
      </div>
      <div className="dn-lema">Nunca fue tan fácil gestionar tu negocio</div>
    </div>
  )
}
