-- =====================================================================
-- FASE 2 — Infraestructura de datos (aprobada). Ejecutar completo, en orden.
-- Todo es aditivo: no se borra ni renombra ninguna columna/tabla existente.
-- =====================================================================

-- ---------- 1. Columnas nuevas en quotes ----------
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS lifecycle_status text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS receipt_status text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS quote_type text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS requires_service boolean;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS service_address text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS client_snapshot jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS company_snapshot jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS pdf_storage_path text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS cancelled_reason text;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accepted_method text;

-- ---------- 2. Columnas nuevas en catalog_items ----------
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS type text;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS sku text;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS tags text[];
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS specs jsonb DEFAULT '{}'::jsonb;

-- ---------- 3. Columnas nuevas en clients ----------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS active boolean;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS razon_social text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS nombre_comercial text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS rfc text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS regimen_fiscal text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS cp_fiscal text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tags text[];

-- ---------- 4. Columnas nuevas en app_config ----------
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS website text;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS razon_social text;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS rfc text;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS regimen_fiscal text;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS cp_fiscal text;

-- ---------- 5. Backfill determinista (nada inventado) ----------
UPDATE quotes SET lifecycle_status = CASE WHEN contracted THEN 'contratado' ELSE 'cotizacion' END
  WHERE status = 'cotizacion' AND lifecycle_status IS NULL;

UPDATE quotes SET receipt_status = 'vigente'
  WHERE status = 'recibo' AND receipt_status IS NULL;

UPDATE quotes SET requires_service = EXISTS (SELECT 1 FROM services WHERE services.quote_id = quotes.id)
  WHERE requires_service IS NULL;

UPDATE quotes SET client_snapshot = jsonb_build_object(
  'name', client_name, 'phone', client_phone, 'email', client_email, 'address', client_address,
  'source', 'reconstructed_from_legacy_columns'
) WHERE client_snapshot IS NULL;

UPDATE clients SET active = true WHERE active IS NULL;

-- quote_type, clients.kind, company_snapshot: se quedan en NULL a propósito (legacy/test, sin inventar dato).

-- ---------- 6. Defaults/NOT NULL donde es seguro ----------
ALTER TABLE quotes ALTER COLUMN requires_service SET DEFAULT false;
ALTER TABLE quotes ALTER COLUMN requires_service SET NOT NULL;
ALTER TABLE clients ALTER COLUMN active SET DEFAULT true;
ALTER TABLE clients ALTER COLUMN active SET NOT NULL;

-- ---------- 7. Constraints ----------
ALTER TABLE quotes ADD CONSTRAINT quotes_folio_unique UNIQUE (folio);

-- Ojo: envuelto en COALESCE — un CHECK de Postgres "pasa" si la expresión da NULL,
-- no solo si da TRUE. Sin el COALESCE, una fila 'cotizacion' con lifecycle_status
-- en NULL se habría colado sin error.
ALTER TABLE quotes ADD CONSTRAINT quotes_status_lifecycle_check CHECK (
  COALESCE(
    (status = 'cotizacion' AND lifecycle_status IN ('cotizacion','contratado','cancelado') AND receipt_status IS NULL)
    OR
    (status = 'recibo' AND receipt_status IN ('vigente','cancelado') AND lifecycle_status IS NULL),
    false
  )
);

ALTER TABLE quotes ADD CONSTRAINT quotes_type_check
  CHECK (quote_type IS NULL OR quote_type IN ('instalacion','servicio','venta'));

ALTER TABLE catalog_items ADD CONSTRAINT catalog_type_check
  CHECK (type IS NULL OR type IN ('producto','servicio'));
ALTER TABLE catalog_items ADD CONSTRAINT catalog_sku_unique UNIQUE (sku);

ALTER TABLE clients ADD CONSTRAINT clients_kind_check
  CHECK (kind IS NULL OR kind IN ('persona','empresa'));

-- 1 cotización -> máximo 1 recibo (índice único parcial sobre el mecanismo actual)
CREATE UNIQUE INDEX quotes_related_folio_unique_receipt
  ON quotes (related_folio) WHERE status = 'recibo' AND related_folio IS NOT NULL;

-- FK real cotización->recibo (posible porque folio ya es UNIQUE); RESTRICT: no se
-- puede borrar físicamente una cotización mientras tenga un recibo apuntándole.
ALTER TABLE quotes ADD CONSTRAINT quotes_related_folio_fkey
  FOREIGN KEY (related_folio) REFERENCES quotes(folio) ON DELETE RESTRICT;

-- ---------- 8. Búsqueda de catálogo ----------
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS catalog_items_name_trgm ON catalog_items USING gin (name gin_trgm_ops);

-- ---------- 9. Tablas nuevas: direcciones y contactos de cliente ----------
CREATE TABLE IF NOT EXISTS client_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label text,
  address text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_addresses_client_idx ON client_addresses(client_id);

CREATE TABLE IF NOT EXISTS client_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name text NOT NULL,
  role text,
  phone text,
  email text,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_contacts_client_idx ON client_contacts(client_id);

-- Backfill 1:1 desde lo ya existente (idempotente: no duplica si se re-corre)
INSERT INTO client_addresses (client_id, label, address, is_primary)
  SELECT id, 'Principal', address, true FROM clients
  WHERE address IS NOT NULL AND address <> ''
    AND NOT EXISTS (SELECT 1 FROM client_addresses ca WHERE ca.client_id = clients.id);

INSERT INTO client_contacts (client_id, name, phone, email, is_primary)
  SELECT id, name, phone, email, true FROM clients
  WHERE NOT EXISTS (SELECT 1 FROM client_contacts cc WHERE cc.client_id = clients.id);

-- ---------- 10. Favoritos de catálogo (por usuario) ----------
CREATE TABLE IF NOT EXISTS catalog_favorites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, catalog_item_id)
);

-- ---------- 11. Aceptación digital (QR) ----------
CREATE TABLE IF NOT EXISTS quote_acceptance_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL UNIQUE REFERENCES quotes(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

CREATE TABLE IF NOT EXISTS quote_acceptance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id),
  token_id uuid REFERENCES quote_acceptance_tokens(id),
  folio text NOT NULL,
  client_name text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL DEFAULT 'qr_publico',
  ip_address text,
  user_agent text
);
CREATE INDEX IF NOT EXISTS quote_acceptance_events_quote_idx ON quote_acceptance_events(quote_id);

-- ---------- 12. Auditoría general ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  event_type text NOT NULL,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at);

-- ---------- 13. RLS: tablas nuevas ----------
ALTER TABLE client_addresses ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_addresses_shared ON client_addresses FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

ALTER TABLE client_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_contacts_shared ON client_contacts FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

ALTER TABLE catalog_favorites ENABLE ROW LEVEL SECURITY;
CREATE POLICY catalog_favorites_owner ON catalog_favorites FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- quote_acceptance_tokens: RLS activo, SIN policies para 'authenticated' -> acceso
-- denegado por defecto a cualquier cliente logueado. Solo service_role (que
-- bypassa RLS, como ya usan las rutas /api/services/*) puede leerla/escribirla.
ALTER TABLE quote_acceptance_tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE quote_acceptance_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY quote_acceptance_events_select ON quote_acceptance_events FOR SELECT TO authenticated
  USING (true);
-- Sin policy de INSERT/UPDATE/DELETE para 'authenticated': inmutable salvo por service_role.

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_select ON audit_log FOR SELECT TO authenticated USING (true);
CREATE POLICY audit_log_insert ON audit_log FOR INSERT TO authenticated
  WITH CHECK (actor_user_id = auth.uid());
-- El cliente autenticado SOLO puede insertar con su propio auth.uid(); nunca NULL.
-- service_role sí puede insertar NULL (eventos generados por el sistema), porque
-- bypassa esta policy igual que bypassa todas las demás.

-- ---------- 14. Candado de cotizaciones contratadas/canceladas ----------
-- DELIBERADAMENTE FUERA DE ESTA EJECUCIÓN (decisión explícita, 2026-09-25).
-- El código actual en producción todavía edita cotizaciones contratadas y usa
-- `contracted=true` directamente — activar este candado ahora rompería ese flujo
-- antes de que la Fase 6 lo migre. Se implementa junto con Fase 6:
--
-- CREATE POLICY quotes_update_lock ON quotes AS RESTRICTIVE FOR UPDATE
--   USING      (status = 'cotizacion' AND lifecycle_status = 'cotizacion')
--   WITH CHECK (status = 'cotizacion' AND lifecycle_status = 'cotizacion');
