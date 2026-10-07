// lib/clientDetails.js
// Direcciones, contactos, favoritos y activar/desactivar de clientes — separado
// de la UI para que Fase 5 (Nueva Cotización) pueda reutilizarlo más adelante.
//
// Toda escritura sobre client_addresses/client_contacts pasa por las RPC de
// Fase 4 (create_/update_/set_primary_/delete_client_address|contact), nunca
// por insert/update/delete directo — así clients.address/phone/email (el
// espejo legacy) queda siempre sincronizado por la base de datos, en una sola
// transacción, sin importar desde dónde se llame.
import { supabase } from './supabaseClient'

export const KIND_LABEL = { persona: 'Persona', empresa: 'Empresa' }
export function kindLabel(kind) {
  return KIND_LABEL[kind] || 'Sin clasificar'
}

// ---------- Historial / eliminación vs desactivación ----------
// No debe decidirse solo por el error de FK: se consulta primero si existe
// al menos una cotización de este cliente.
export async function hasQuoteHistory(clientId) {
  const { count } = await supabase
    .from('quotes')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
  return (count || 0) > 0
}

export async function deactivateClient(clientId) {
  return supabase.from('clients').update({ active: false, updated_at: new Date().toISOString() }).eq('id', clientId)
}

export async function reactivateClient(clientId) {
  return supabase.from('clients').update({ active: true, updated_at: new Date().toISOString() }).eq('id', clientId)
}

export async function deleteClientPhysically(clientId) {
  return supabase.from('clients').delete().eq('id', clientId)
}

// ---------- Favoritos de cliente (por usuario, tabla independiente de clients) ----------
export async function getFavoriteClientIds(userId) {
  if (!userId) return new Set()
  const { data } = await supabase.from('client_favorites').select('client_id').eq('user_id', userId)
  return new Set((data || []).map((r) => r.client_id))
}

export async function setClientFavorite(userId, clientId, isFavorite) {
  if (isFavorite) {
    return supabase.from('client_favorites').insert({ user_id: userId, client_id: clientId })
  }
  return supabase.from('client_favorites').delete().eq('user_id', userId).eq('client_id', clientId)
}

// ---------- Direcciones (client_addresses) ----------
export async function fetchAddresses(clientId) {
  const { data } = await supabase.from('client_addresses').select('*').eq('client_id', clientId).order('created_at')
  return data || []
}
export function createAddress(clientId, { address, label, isPrimary }) {
  return supabase.rpc('create_client_address', {
    p_client_id: clientId, p_address: address, p_label: label || null, p_is_primary: !!isPrimary,
  })
}
export function updateAddress(addressId, { address, label }) {
  return supabase.rpc('update_client_address', { p_address_id: addressId, p_address: address, p_label: label || null })
}
export function setPrimaryAddress(clientId, addressId) {
  return supabase.rpc('set_primary_client_address', { p_client_id: clientId, p_address_id: addressId })
}
export function deleteAddress(addressId) {
  return supabase.rpc('delete_client_address', { p_address_id: addressId })
}

// ---------- Contactos (client_contacts) ----------
export async function fetchContacts(clientId) {
  const { data } = await supabase.from('client_contacts').select('*').eq('client_id', clientId).order('created_at')
  return data || []
}
export function createContact(clientId, { name, role, phone, email, isPrimary }) {
  return supabase.rpc('create_client_contact', {
    p_client_id: clientId, p_name: name, p_role: role || null, p_phone: phone || null, p_email: email || null, p_is_primary: !!isPrimary,
  })
}
export function updateContact(contactId, { name, role, phone, email }) {
  return supabase.rpc('update_client_contact', {
    p_contact_id: contactId, p_name: name, p_role: role || null, p_phone: phone || null, p_email: email || null,
  })
}
export function setPrimaryContact(clientId, contactId) {
  return supabase.rpc('set_primary_client_contact', { p_client_id: clientId, p_contact_id: contactId })
}
export function deleteContact(contactId) {
  return supabase.rpc('delete_client_contact', { p_contact_id: contactId })
}
