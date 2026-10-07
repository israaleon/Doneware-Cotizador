// lib/pdfModel.js
// Fase 6.1 — resolver histórico del modelo documental.
//
// Función PURA: no hace queries, no toca Supabase ni Storage, no muta `rec`
// ni `liveConfig`. Su único trabajo es decidir, campo por campo, de dónde
// viene cada dato para que `lib/pdf.js` nunca tenga que volver a elegir
// entre snapshot/legacy/config — esa decisión vive exclusivamente aquí.
//
// Regla de cliente/empresa: si el snapshot correspondiente existe (Fase 5+),
// SIEMPRE se usa — un campo faltante dentro de un snapshot moderno cae a un
// valor local seguro (columnas planas del mismo registro para cliente, ''
// para empresa), NUNCA a `liveConfig`/datos maestros actuales. Solo cuando
// el snapshot completo es null (documento legacy) se usa el fallback
// esperado: columnas planas para cliente, `liveConfig` para empresa.

function resolveClient(rec) {
  const snap = rec.client_snapshot
  if (snap) {
    // Moderno (Fase 5+). Un campo ausente dentro del snapshot cae a la
    // columna plana del MISMO registro (también histórica, nunca a datos
    // maestros actuales) — fallback defensivo documentado, no legacy real.
    return {
      name: snap.name || rec.client_name || '',
      address: snap.selected_address?.address || rec.client_address || '',
      phone: snap.selected_contact?.phone || rec.client_phone || '',
      email: snap.selected_contact?.email || rec.client_email || '',
    }
  }
  // Legacy: nunca hubo snapshot — las columnas planas son la única fuente.
  return {
    name: rec.client_name || '',
    address: rec.client_address || '',
    phone: rec.client_phone || '',
    email: rec.client_email || '',
  }
}

function resolveCompany(rec, liveConfig) {
  const snap = rec.company_snapshot
  if (snap) {
    // Moderno: un campo ausente se queda en '' — jamás se rellena con
    // liveConfig, que sería usar configuración actual para un documento que
    // debería estar congelado.
    return {
      logo_url: snap.logo_url || '',
      // Fase 6.4B: ruta privada al logo histórico, solo si este snapshot
      // moderno la tiene. Ausente aquí -> pdf.js cae a logo_url del MISMO
      // snapshot, nunca a liveConfig (ver más abajo, rama legacy).
      logo_storage_path: snap.logo_storage_path || '',
      company_name: snap.company_name || '',
      phone: snap.phone || '',
      email: snap.email || '',
      address: snap.address || '',
      bank_info: snap.bank_info || '',
      terms: snap.terms || '',
    }
  }
  // Legacy: nunca hubo snapshot — liveConfig es el fallback esperado y
  // documentado (mismo comportamiento que tenía la app antes de Fase 5).
  return {
    logo_url: liveConfig.logo_url || '',
    // Legacy puro nunca tiene copia privada — solo puede depender de
    // liveConfig, exactamente como antes de Fase 6.4.
    logo_storage_path: '',
    company_name: liveConfig.company_name || '',
    phone: liveConfig.phone || '',
    email: liveConfig.email || '',
    address: liveConfig.address || '',
    bank_info: liveConfig.bank_info || '',
    terms: liveConfig.terms || '',
  }
}

// rec: fila de `quotes` (o un objeto con la misma forma antes de insertarse).
// liveConfig: fila de `app_config`, usada únicamente como fallback legacy.
export function resolveDocumentModel(rec, liveConfig) {
  return {
    status: rec.status,
    isReceipt: rec.status === 'recibo',
    folio: rec.folio,
    related_folio: rec.related_folio ?? null,
    created_at: rec.created_at,
    valid_days: rec.valid_days,
    // Fase 6.7C-1: fecha de vencimiento calculada por PostgreSQL (o, en un
    // PDF candidato, el valor candidato que la publicación verifica contra
    // la DB). null en filas/objetos que no la traen -> pdf.js cae al cálculo
    // anterior, solo para ese caso.
    valid_until: rec.valid_until ?? null,

    client: resolveClient(rec),
    company: resolveCompany(rec, liveConfig),

    // Los items ya son, por diseño, un registro congelado desde que se
    // guardaron (Fase 3/5) — se pasan tal cual, sin mutar ni recalcular aquí.
    items: rec.items || [],

    subtotal: rec.subtotal,
    discount: rec.discount,
    iva: rec.iva,
    iva_rate: rec.iva_rate,
    apply_iva: rec.apply_iva,
    total: rec.total,

    install_time_value: rec.install_time_value,
    install_time_unit: rec.install_time_unit,
    notes: rec.notes,

    // Fase 6.2 — layouts especializados. Siempre desde columnas históricas de
    // `rec`, nunca desde una consulta adicional.
    quote_type: rec.quote_type ?? null,
    requires_service: rec.requires_service ?? false,
    service_address: rec.service_address ?? null,

    // Metadata interna para pruebas/depuración — el render de 6.1 no la usa.
    _source: {
      client: rec.client_snapshot ? 'snapshot' : 'legacy',
      company: rec.company_snapshot ? 'snapshot' : 'legacy',
    },
  }
}
