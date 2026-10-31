// lib/unsavedGuard.js — N2 (ronda Donnie): aviso mínimo antes de abandonar el formulario del Cotizador con cambios sin guardar.
// El formulario (app/cotizar/page.js) registra UNA función que responde «¿hay cambios sin guardar?»; la navegación del marco
// (menú, barras, avatar) la consulta y, solo si hay cambios Y la acción descartaría el formulario, pide confirmación.
// No guarda ni persiste nada: no hay borradores entre pantallas.

let getter = null

// fn: () => boolean | null. El formulario la registra al montarse y la retira al desmontarse.
export function registerUnsavedGuard(fn) {
  getter = typeof fn === 'function' ? fn : null
}

export function hasUnsavedChanges() {
  try { return !!(getter && getter()) } catch { return false }
}

export const UNSAVED_MESSAGE = 'Tienes cambios sin guardar en esta cotización. Si sales ahora, se perderán.\n\n¿Salir sin guardar?'

// true = se puede continuar (no hay cambios o la persona confirmó descartarlos).
export function confirmDiscard(confirmFn = (typeof window !== 'undefined' ? window.confirm.bind(window) : () => true)) {
  if (!hasUnsavedChanges()) return true
  return !!confirmFn(UNSAVED_MESSAGE)
}

// ¿Ir a `target` descarta la pantalla actual? Mismo camino y misma consulta = no hay navegación real (el formulario se conserva tal cual).
export function navigationWouldDiscard(current, target) {
  try {
    const base = 'http://x'
    const c = new URL(current, base), t = new URL(target, base)
    return !(c.pathname === t.pathname && c.search === t.search)
  } catch {
    return true
  }
}
