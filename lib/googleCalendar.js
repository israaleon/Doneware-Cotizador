// lib/googleCalendar.js — SOLO servidor.
import { supabaseAdmin } from './supabaseAdmin'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

export async function getValidAccessToken(userId) {
  const { data: creds } = await supabaseAdmin
    .from('google_calendar_credentials')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (!creds || !creds.refresh_token) {
    throw new Error('Todavía no conectaste tu Google Calendar. Ve a Configuración → "Mi Google Calendar".')
  }

  if (creds.access_token && creds.expires_at && Date.now() < new Date(creds.expires_at).getTime() - 60000) {
    return creds.access_token
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: creds.refresh_token,
    }),
  })
  const json = await res.json()
  if (!res.ok) {
    throw new Error('No se pudo refrescar tu token de Google (' + (json.error || res.status) + '). Vuelve a conectar tu calendario en Configuración.')
  }

  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString()
  await supabaseAdmin.from('google_calendar_credentials').update({
    access_token: json.access_token,
    expires_at: expiresAt,
  }).eq('user_id', userId)

  return json.access_token
}

function buildEventBody({ title, description, startAt, durationMinutes, location }) {
  const start = new Date(startAt)
  const end = new Date(start.getTime() + durationMinutes * 60000)
  return {
    summary: title,
    description,
    location: location || '',
    start: { dateTime: start.toISOString(), timeZone: 'America/Mexico_City' },
    end: { dateTime: end.toISOString(), timeZone: 'America/Mexico_City' },
  }
}

export async function createEvent(userId, eventData) {
  const token = await getValidAccessToken(userId)
  const res = await fetch(EVENTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildEventBody(eventData)),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error?.message || 'Google Calendar rechazó la creación del evento.')
  return { eventId: json.id, eventLink: json.htmlLink }
}

export async function updateEvent(userId, eventId, eventData) {
  const token = await getValidAccessToken(userId)
  const res = await fetch(`${EVENTS_URL}/${eventId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildEventBody(eventData)),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error?.message || 'Google Calendar rechazó la actualización del evento.')
  return { eventId: json.id, eventLink: json.htmlLink }
}

export async function deleteEvent(userId, eventId) {
  const token = await getValidAccessToken(userId)
  const res = await fetch(`${EVENTS_URL}/${eventId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  // 404/410 significan "ya no existe" — no es un error para nuestros fines.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const json = await res.json().catch(() => ({}))
    throw new Error(json.error?.message || 'Google Calendar rechazó la cancelación del evento.')
  }
}
