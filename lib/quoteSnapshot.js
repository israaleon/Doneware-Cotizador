// lib/quoteSnapshot.js
// Snapshots de Fase 5: arman la "fotografía" congelada de cliente, empresa y
// cada concepto de una cotización en el momento de guardarla, para que más
// adelante (Fase 6) el documento se pueda reconstruir sin depender de datos
// que después cambien en Clientes, Catálogo o Configuración. Separado de la
// UI para que Fase 6 reutilice exactamente esta misma forma sin duplicarla.
// Solo aplica al camino nuevo de Fase 5 — nunca al de una cotización
// contratada, que sigue su propio camino legacy sin snapshots.

export function computeRequiresServiceSuggestion(quoteType, items) {
  if (quoteType === 'instalacion' || quoteType === 'servicio') return true
  if (quoteType === 'venta') return (items || []).some((it) => it.item_type === 'servicio')
  return false
}

// ---------- Items ----------
// Copia completa del concepto de catálogo al agregarlo: desde ese momento la
// línea queda desacoplada — editar la línea nunca reescribe catalog_items, y
// cambiar después el catálogo nunca altera una línea ya agregada.
export function catalogItemToLine(catalogItem, qty, price) {
  const q = Number(qty) || 1
  const p = price === '' || price == null ? Number(catalogItem.price) || 0 : Number(price) || 0
  return {
    source: 'catalog',
    catalog_item_id: catalogItem.id,
    item_type: catalogItem.type || null,
    name: catalogItem.name,
    sku: catalogItem.sku || null,
    category: catalogItem.category || null,
    tags: catalogItem.tags || [],
    specs: catalogItem.specs || {},
    unit: catalogItem.unit || '',
    qty: q,
    price: p,
    subtotal: q * p,
  }
}

export function manualLine() {
  return {
    source: 'manual', catalog_item_id: null, item_type: null,
    name: '', sku: null, category: null, tags: [], specs: {},
    unit: '', qty: 1, price: '', subtotal: 0,
  }
}

// El subtotal de una línea nunca se confía tal cual venía en memoria o en un
// registro existente — siempre se recalcula desde qty/price actuales.
export function withRecalculatedSubtotal(item) {
  const qty = Number(item.qty) || 0
  const price = Number(item.price) || 0
  return { ...item, subtotal: qty * price }
}

// Normaliza un item de un registro existente (nuevo de Fase 5 o legacy) a la
// forma completa de arriba. Nunca inventa catalog_item_id/sku/category/tags/
// specs si el dato no los traía ya — quedan en null/[]/{}.
export function normalizeItem(raw) {
  return withRecalculatedSubtotal({
    source: raw.source || 'manual',
    catalog_item_id: raw.catalog_item_id ?? null,
    item_type: raw.item_type ?? null,
    name: raw.name || '',
    sku: raw.sku ?? null,
    category: raw.category ?? null,
    tags: raw.tags || [],
    specs: raw.specs || {},
    unit: raw.unit || '',
    qty: raw.qty,
    price: raw.price,
  })
}

// ---------- Client snapshot ----------
// client: fila completa de `clients`, o null si es un cliente nuevo sin ficha.
// draftClient: { name, phone, email, address } tal como quedó en el formulario.
// selectedAddress/selectedContact: fila completa de client_addresses/
// client_contacts realmente elegida, o null.
// serviceAddress: { origin, addressId, address } ya resuelto, o null si la
// cotización no requiere servicio.
export function buildClientSnapshot({ client, draftClient, selectedAddress, selectedContact, serviceAddress }) {
  return {
    client_id: client?.id ?? null,
    kind: client?.kind ?? null,
    name: draftClient.name || '',
    razon_social: client?.razon_social ?? null,
    nombre_comercial: client?.nombre_comercial ?? null,
    rfc: client?.rfc ?? null,
    regimen_fiscal: client?.regimen_fiscal ?? null,
    cp_fiscal: client?.cp_fiscal ?? null,
    notes: client?.notes ?? null,
    tags: client?.tags || [],
    selected_address: selectedAddress
      ? { id: selectedAddress.id, label: selectedAddress.label || null, address: selectedAddress.address }
      : (draftClient.address ? { id: null, label: null, address: draftClient.address } : null),
    selected_contact: selectedContact
      ? { id: selectedContact.id, name: selectedContact.name, role: selectedContact.role || null, phone: selectedContact.phone || '', email: selectedContact.email || '' }
      : ((draftClient.phone || draftClient.email) ? { id: null, name: draftClient.name || '', role: null, phone: draftClient.phone || '', email: draftClient.email || '' } : null),
    service_address: serviceAddress ? {
      address_id: serviceAddress.addressId,
      address: serviceAddress.address,
      origin: serviceAddress.origin,
    } : null,
  }
}

// ---------- Términos / datos de pago efectivos (Fase 6.3B) ----------
// "Sin contenido" = ausente, undefined, null, '' o solo espacios — siempre
// normalizado con trim(). Puras y defensivas: un quoteType null/vacío/
// desconocido NUNCA busca ni inventa un override — usa directamente el valor
// general. Esto protege legacy y cualquier caso inesperado futuro.
function normalizeText(v) {
  return (v ?? '').toString().trim()
}

export function resolveEffectiveTerms(config, quoteType) {
  const general = normalizeText(config.terms)
  const specific = quoteType ? normalizeText(config.terms_by_type?.[quoteType]) : ''
  if (general && specific) return general + '\n\n' + specific
  return general || specific || ''
}

export function resolveEffectiveBankInfo(config, quoteType) {
  const specific = quoteType ? normalizeText(config.bank_info_by_type?.[quoteType]) : ''
  if (specific) return specific
  return normalizeText(config.bank_info)
}

// ---------- Company snapshot ----------
// Únicamente columnas reales de app_config, verificadas por introspección.
// Se excluyen a propósito: id, valid_days (vive en quotes.valid_days) y las
// plantillas de envío por correo/whatsapp (son config de notificación, no
// contenido del documento). `terms`/`bank_info` se guardan ya RESUELTOS
// (efectivos para `quoteType`) — nunca se guarda `terms_by_type`/
// `bank_info_by_type` crudos: el documento histórico necesita el resultado
// ya fusionado, no la configuración global completa.
export function buildCompanySnapshot(config, quoteType) {
  return {
    company_name: config.company_name ?? null,
    phone: config.phone ?? null,
    email: config.email ?? null,
    address: config.address ?? null,
    website: config.website ?? null,
    razon_social: config.razon_social ?? null,
    rfc: config.rfc ?? null,
    regimen_fiscal: config.regimen_fiscal ?? null,
    cp_fiscal: config.cp_fiscal ?? null,
    logo_url: config.logo_url ?? null,
    bank_info: resolveEffectiveBankInfo(config, quoteType),
    terms: resolveEffectiveTerms(config, quoteType),
    iva_rate: config.iva_rate ?? null,
    apply_iva: config.apply_iva ?? null,
  }
}
