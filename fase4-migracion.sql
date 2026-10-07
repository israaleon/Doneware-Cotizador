-- ============================================================================
-- FASE 4 — MIGRACIÓN: favoritos de cliente, integridad de "principal" y RPCs
-- de dirección/contacto (diseño v4 aprobado). Solo base de datos, sin UI.
--
-- Alcance de este archivo (nada más):
--   1. Tabla client_favorites + RLS personal por usuario
--   2. Índices únicos parciales: un solo principal por cliente
--   3. 8 funciones RPC (crear/editar/promover/borrar dirección y contacto)
--      que mantienen sincronizados clients.address / clients.phone / clients.email
--   4. GRANT EXECUTE de esas funciones a "authenticated"
--
-- No toca: quotes, columnas de clients, RLS existente de clients/client_addresses/
-- client_contacts, Storage, ni ninguna tabla fuera de la lista de arriba.
-- ============================================================================

-- ---------- 1. Favoritos de cliente (calcado de catalog_favorites) ----------
CREATE TABLE IF NOT EXISTS client_favorites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_id)
);

ALTER TABLE client_favorites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_favorites_owner ON client_favorites;
CREATE POLICY client_favorites_owner ON client_favorites FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ---------- 2. Un solo "principal" por cliente, forzado en base de datos ----------
-- Verificado antes de este archivo (solo lectura, sin corregir nada): 0 clientes
-- con más de una dirección principal, 0 con más de un contacto principal. Los
-- índices se pueden crear directamente sobre los datos reales.
CREATE UNIQUE INDEX IF NOT EXISTS client_addresses_one_primary
  ON client_addresses (client_id) WHERE is_primary;

CREATE UNIQUE INDEX IF NOT EXISTS client_contacts_one_primary
  ON client_contacts (client_id) WHERE is_primary;

-- ---------- 3. RPCs de dirección ----------
-- SECURITY INVOKER (default): corren con los privilegios/RLS del usuario que
-- llama. Como client_addresses/client_contacts ya tienen policy
-- "FOR ALL TO authenticated USING (true) WITH CHECK (true)", cualquier usuario
-- autenticado puede ejecutarlas sin necesidad de SECURITY DEFINER.

CREATE OR REPLACE FUNCTION create_client_address(
  p_client_id uuid, p_address text, p_label text DEFAULT NULL, p_is_primary boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_is_primary THEN
    UPDATE client_addresses SET is_primary = false
      WHERE client_id = p_client_id AND is_primary;
  END IF;

  INSERT INTO client_addresses (client_id, address, label, is_primary)
    VALUES (p_client_id, p_address, p_label, p_is_primary)
    RETURNING id INTO v_id;

  IF p_is_primary THEN
    UPDATE clients SET address = p_address, updated_at = now() WHERE id = p_client_id;
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION update_client_address(
  p_address_id uuid, p_address text, p_label text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_client_id uuid;
  v_is_primary boolean;
BEGIN
  SELECT client_id, is_primary INTO v_client_id, v_is_primary
    FROM client_addresses WHERE id = p_address_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La dirección % no existe', p_address_id;
  END IF;

  UPDATE client_addresses SET address = p_address, label = p_label WHERE id = p_address_id;

  IF v_is_primary THEN
    UPDATE clients SET address = p_address, updated_at = now() WHERE id = v_client_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION set_primary_client_address(p_client_id uuid, p_address_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_address text;
BEGIN
  SELECT address INTO v_address FROM client_addresses
    WHERE id = p_address_id AND client_id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La dirección % no pertenece al cliente %', p_address_id, p_client_id;
  END IF;

  UPDATE client_addresses SET is_primary = false
    WHERE client_id = p_client_id AND is_primary AND id <> p_address_id;
  UPDATE client_addresses SET is_primary = true WHERE id = p_address_id;
  UPDATE clients SET address = v_address, updated_at = now() WHERE id = p_client_id;
END;
$$;

CREATE OR REPLACE FUNCTION delete_client_address(p_address_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_client_id uuid;
  v_was_primary boolean;
BEGIN
  SELECT client_id, is_primary INTO v_client_id, v_was_primary
    FROM client_addresses WHERE id = p_address_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La dirección % no existe', p_address_id;
  END IF;

  DELETE FROM client_addresses WHERE id = p_address_id;

  IF v_was_primary THEN
    UPDATE clients SET address = NULL, updated_at = now() WHERE id = v_client_id;
  END IF;
END;
$$;

-- ---------- 4. RPCs de contacto (mismo patrón, phone + email juntos) ----------

CREATE OR REPLACE FUNCTION create_client_contact(
  p_client_id uuid, p_name text, p_role text DEFAULT NULL,
  p_phone text DEFAULT NULL, p_email text DEFAULT NULL, p_is_primary boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_is_primary THEN
    UPDATE client_contacts SET is_primary = false
      WHERE client_id = p_client_id AND is_primary;
  END IF;

  INSERT INTO client_contacts (client_id, name, role, phone, email, is_primary)
    VALUES (p_client_id, p_name, p_role, p_phone, p_email, p_is_primary)
    RETURNING id INTO v_id;

  IF p_is_primary THEN
    UPDATE clients SET phone = p_phone, email = p_email, updated_at = now() WHERE id = p_client_id;
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION update_client_contact(
  p_contact_id uuid, p_name text, p_role text DEFAULT NULL,
  p_phone text DEFAULT NULL, p_email text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_client_id uuid;
  v_is_primary boolean;
BEGIN
  SELECT client_id, is_primary INTO v_client_id, v_is_primary
    FROM client_contacts WHERE id = p_contact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El contacto % no existe', p_contact_id;
  END IF;

  UPDATE client_contacts SET name = p_name, role = p_role, phone = p_phone, email = p_email
    WHERE id = p_contact_id;

  IF v_is_primary THEN
    UPDATE clients SET phone = p_phone, email = p_email, updated_at = now() WHERE id = v_client_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION set_primary_client_contact(p_client_id uuid, p_contact_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_phone text;
  v_email text;
BEGIN
  SELECT phone, email INTO v_phone, v_email FROM client_contacts
    WHERE id = p_contact_id AND client_id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El contacto % no pertenece al cliente %', p_contact_id, p_client_id;
  END IF;

  UPDATE client_contacts SET is_primary = false
    WHERE client_id = p_client_id AND is_primary AND id <> p_contact_id;
  UPDATE client_contacts SET is_primary = true WHERE id = p_contact_id;
  UPDATE clients SET phone = v_phone, email = v_email, updated_at = now() WHERE id = p_client_id;
END;
$$;

CREATE OR REPLACE FUNCTION delete_client_contact(p_contact_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_client_id uuid;
  v_was_primary boolean;
BEGIN
  SELECT client_id, is_primary INTO v_client_id, v_was_primary
    FROM client_contacts WHERE id = p_contact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El contacto % no existe', p_contact_id;
  END IF;

  DELETE FROM client_contacts WHERE id = p_contact_id;

  IF v_was_primary THEN
    UPDATE clients SET phone = NULL, email = NULL, updated_at = now() WHERE id = v_client_id;
  END IF;
END;
$$;

-- ---------- 5. Permisos ----------
GRANT EXECUTE ON FUNCTION create_client_address(uuid, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION update_client_address(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION set_primary_client_address(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION delete_client_address(uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION create_client_contact(uuid, text, text, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION update_client_contact(uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION set_primary_client_contact(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION delete_client_contact(uuid) TO authenticated;
