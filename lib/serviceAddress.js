// lib/serviceAddress.js
// Dirección de servicio de una cotización: estado inicial del formulario al EDITAR y resolución al guardar. Sin React ni Supabase.
//
// Qué se guarda: la columna plana `service_address` (la que usan el PDF y la contratación) y `client_snapshot.service_address`
// ({ origin, address_id, address }) de cada revisión. El formulario debe arrancar la edición con ESA dirección: si no, un guardado sin tocarla la
// sustituye en silencio por la del cliente.
//
// Regla: nunca se pierde una dirección guardada. Un origen basado en el cliente solo se conserva si la dirección del cliente HOY sigue siendo
// exactamente el texto guardado; si cambió (o no se puede comprobar), la dirección guardada se conserva como MANUAL.

const text = (v) => (typeof v === 'string' ? v.trim() : '')

// rec: fila guardada; addresses: direcciones actuales del cliente (puede estar vacío si aún no cargaron);
// selectedAddressId: dirección del cliente elegida en el formulario; clientAddressText: dirección plana del cliente en la fila (respaldo).
export function initialServiceAddress({ rec, addresses = [], selectedAddressId = null, clientAddressText = '' }) {
  const none = { origin: 'selected_client_address', otherAddressId: null, manualAddress: '', preserved: false }
  if (!rec || rec.requires_service === false) return none
  const snap = rec.client_snapshot && typeof rec.client_snapshot === 'object' ? rec.client_snapshot.service_address : null
  const saved = text(snap && snap.address) || text(rec.service_address)
  if (!saved) return none
  const origin = snap && typeof snap.origin === 'string' ? snap.origin : null
  const manual = { origin: 'manual', otherAddressId: null, manualAddress: saved, preserved: true }
  if (origin === 'other_client_address') {
    const a = addresses.find((x) => x.id === snap.address_id)
    return a && text(a.address) === saved ? { origin: 'other_client_address', otherAddressId: a.id, manualAddress: '', preserved: true } : manual
  }
  if (origin === 'manual') return manual
  // Fila histórica sin origen registrado: se abre como manual con EXACTAMENTE el texto guardado; el origen no se atribuye por coincidencia con la dirección del cliente.
  if (origin !== 'selected_client_address') {
    const raw = [snap && snap.address, rec.service_address].find((v) => typeof v === 'string' && v.trim()) || saved
    return { origin: 'manual', otherAddressId: null, manualAddress: raw, preserved: true }
  }
  // 'selected_client_address' persistido: solo se conserva «la del cliente» si hoy coincide con lo guardado
  const sel = addresses.find((x) => x.id === selectedAddressId)
  const current = text(sel ? sel.address : clientAddressText)
  return current && current === saved ? { origin: 'selected_client_address', otherAddressId: null, manualAddress: '', preserved: true } : manual
}

// Dirección que se guardará según la elección del formulario. { origin, addressId, address }
export function resolveServiceAddress({ origin, otherAddressId, manualAddress, addresses = [], selectedAddressId = null, draftClientAddress = '' }) {
  if (origin === 'manual') return { origin: 'manual', addressId: null, address: manualAddress }
  if (origin === 'other_client_address') {
    const a = addresses.find((x) => x.id === otherAddressId)
    return { origin: 'other_client_address', addressId: a ? a.id : null, address: a ? a.address : '' }
  }
  const a = addresses.find((x) => x.id === selectedAddressId)
  return { origin: 'selected_client_address', addressId: a ? a.id : null, address: a ? a.address : draftClientAddress }
}

// Origen PERSISTIDO de la dirección de servicio guardada (no se deduce de coincidencias ni de lo que haya cargado después):
// 'manual' | 'selected_client_address' | 'other_client_address' | 'unknown' (hay dirección pero la fila no registró el origen) | 'none'.
export function persistedServiceOrigin(rec) {
  if (!rec || rec.requires_service === false) return { kind: 'none', text: '' }
  const snap = rec.client_snapshot && typeof rec.client_snapshot === 'object' ? rec.client_snapshot.service_address : null
  const saved = text(snap && snap.address) || text(rec.service_address)
  if (!saved) return { kind: 'none', text: '' }
  const o = snap && typeof snap.origin === 'string' ? snap.origin : null
  if (o === 'manual' || o === 'selected_client_address' || o === 'other_client_address') return { kind: o, text: saved }
  return { kind: 'unknown', text: saved }
}

// Qué pasa con la dirección de servicio cuando la persona CAMBIA de cliente al editar (sin haber tocado la dirección). Depende solo del origen
// persistido y del cliente elegido, nunca de si las direcciones ya cargaron. newClientId: cliente elegido, o null si se limpió la selección.
// Devuelve null si no hay nada que cambiar, o { origin, otherAddressId, manualAddress, pending, restored }:
//   manual → se conserva · del cliente → sigue al nuevo cliente · otra registrada → exige elegir una válida (pendiente, con el texto anterior visible)
//   origen desconocido → el texto queda pendiente de confirmación explícita · mismo cliente que al abrir → vuelve al estado de apertura
export function serviceAddressAfterClientChange({ rec, newClientId = null, clientAddressText = '' }) {
  const p = persistedServiceOrigin(rec)
  if (p.kind === 'none') return null
  if (newClientId && rec.client_id && newClientId === rec.client_id) {
    const i = initialServiceAddress({ rec, addresses: [], selectedAddressId: null, clientAddressText })
    return { origin: i.origin, otherAddressId: i.otherAddressId, manualAddress: i.manualAddress, pending: null, restored: true }
  }
  if (p.kind === 'manual') return null
  if (p.kind === 'selected_client_address') return { origin: 'selected_client_address', otherAddressId: null, manualAddress: '', pending: null, restored: false }
  if (p.kind === 'other_client_address') return { origin: 'other_client_address', otherAddressId: null, manualAddress: '', pending: { kind: 'previous_client_address', text: p.text }, restored: false }
  return { origin: 'manual', otherAddressId: null, manualAddress: '', pending: { kind: 'unknown_origin', text: p.text }, restored: false }
}
