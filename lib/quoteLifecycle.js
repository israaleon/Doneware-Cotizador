// lib/quoteLifecycle.js
// Fase 6.6B — predicados puros sobre el lifecycle contractual de una
// cotización. Fuente de verdad: lifecycle_status — nunca `contracted` solo.
// Desde Fase 6.6A, `contracted` es compatibilidad histórica ("esto se
// contrató alguna vez"): nunca vuelve a false, ni siquiera al cancelar. Por
// eso `contracted === true` YA NO implica que el contrato siga activo.
export function isPrecontractual(rec) {
  return rec.status === 'cotizacion' && rec.lifecycle_status === 'cotizacion'
}

export function isContracted(rec) {
  return rec.status === 'cotizacion' && rec.lifecycle_status === 'contratado'
}

export function isCancelled(rec) {
  return rec.status === 'cotizacion' && rec.lifecycle_status === 'cancelado'
}

export function canEditQuote(rec) {
  return isPrecontractual(rec)
}

export function canDeleteQuote(rec) {
  return isPrecontractual(rec) && rec.contracted === false
}

export function canContractQuote(rec) {
  return isPrecontractual(rec)
}

export function canCancelContract(rec) {
  return isContracted(rec)
}
