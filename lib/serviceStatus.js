// lib/serviceStatus.js
// Estatus de un servicio agendado, compartido entre Servicios, Historial y
// Clientes para que la etiqueta y el color sean siempre los mismos.

export const SERVICE_STATUS_OPTIONS = [
  ['pendiente_agendar', 'Pendiente de agendar'],
  ['agendado', 'Agendado'],
  ['confirmado', 'Confirmado'],
  ['reagendar', 'Por reagendar'],
  ['realizado', 'Realizado'],
  ['cancelado', 'Cancelado'],
]

export const SERVICE_STATUS_LABEL = Object.fromEntries(SERVICE_STATUS_OPTIONS)

export const SERVICE_STATUS_BADGE = {
  pendiente_agendar: 'cot',
  agendado: 'rec',
  confirmado: 'rec',
  reagendar: 'cot',
  realizado: 'rec',
  cancelado: 'can',
}

// La duración se captura en horas/días (igual que el tiempo de instalación
// estimado de una cotización) pero Google Calendar necesita minutos para
// calcular la hora de fin del evento.
export function durationToMinutes(value, unit) {
  const n = Number(value) || 0
  return unit === 'dias' ? n * 24 * 60 : n * 60
}

// Para servicios guardados antes de que existiera duration_value/duration_unit
// (o si por alguna razón faltan), se derivan a partir de duration_minutes.
export function minutesToDuration(minutes) {
  const m = Number(minutes) || 60
  if (m > 0 && m % 1440 === 0) return { value: m / 1440, unit: 'dias' }
  return { value: Math.round((m / 60) * 100) / 100, unit: 'horas' }
}
