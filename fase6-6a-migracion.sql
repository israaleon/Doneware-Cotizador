-- ============================================================================
-- FASE 6.6A-1 — Lifecycle + operaciones atómicas de contratación/cancelación.
--
-- NO INCLUYE EL FREEZE DE RLS (eso vive en fase6-6-freeze.sql, deliberadamente
-- separado — no ejecutar ese archivo hasta cerrar 6.6B: mientras
-- LegacyContractedEditForm siga haciendo UPDATE directo sobre un recibo
-- (app/cotizar/page.js:168, confirmado por grep), activar el freeze ahí
-- rompería ese flujo).
--
-- Diagnóstico real ejecutado antes de escribir este archivo (solo lectura,
-- vía introspección OpenAPI + SELECT reales, sin ninguna escritura):
--   - 5 filas en quotes: 3 cotizaciones, 2 recibos.
--   - Drift lifecycle_status vs contracted: 0 filas afectadas HOY. Las 2
--     contratadas reales (COT-2026-0001, COT-2026-0002) ya tienen
--     lifecycle_status='contratado' porque predatan la migración de Fase 2
--     (el backfill de esa migración las dejó correctas por coincidencia
--     histórica, no por ningún mecanismo vivo — nada transiciona
--     lifecycle_status hoy). El UPDATE de la sección 1 es un no-op seguro
--     ahora mismo, pero es la única red de seguridad ante cualquier
--     contratación real hecha antes de que esta migración se despliegue.
--   - services: exactamente 1 fila real (id 4cb77087-765a-43c0-9652-
--     c5369b982c96, quote_id 53bd2332-e1a7-4326-9290-6984e69fd8cf =
--     COT-2026-0001, creada 2026-09-21, antes de que "origin" existiera como
--     concepto) — confirmado que pertenece al flujo manual existente
--     (/servicios/nuevo), por lo que clasificarla como origin='manual' vía
--     el DEFAULT de la columna nueva es correcto. NO se marca como
--     'contratacion' retroactivamente.
--   - services.quote_id: confirmado EMPÍRICAMENTE (no solo por el código)
--     que existe un UNIQUE real con nombre "services_quote_id_key" —
--     inserté dos filas de prueba con el mismo quote_id vía service_role;
--     la segunda falló con 23505 "duplicate key value violates unique
--     constraint services_quote_id_key"; ambas filas de prueba y sus datos
--     asociados (client/quote de prueba) fueron eliminados de inmediato.
--   - RLS: confirmado empíricamente que tanto quotes como services tienen
--     RLS activo (anon: SELECT devuelve 200 [] pese a haber filas reales;
--     INSERT como anon devuelve 401 "new row violates row-level security
--     policy for table \"quotes\"", code 42501 — error real de Postgres, no
--     de la aplicación). No se pudo obtener el texto literal de la policy
--     de "authenticated" (no hay conexión Postgres directa en este entorno,
--     solo PostgREST) — no hace falta para este archivo, que no toca RLS.
-- ============================================================================


-- ---------- 1. Backfill de lifecycle_status (corrige el drift, hoy 0 filas) ----------
UPDATE quotes SET lifecycle_status = 'contratado'
WHERE status = 'cotizacion' AND contracted = true AND lifecycle_status = 'cotizacion';


-- ---------- 2. Modelo services 1:∞ — retirar el UNIQUE(quote_id) ----------
-- Nombre confirmado empíricamente (ver diagnóstico arriba): services_quote_id_key.
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_quote_id_key;


-- ---------- 3. Columna de idempotencia del servicio inicial ----------
-- El único servicio real existente queda clasificado como 'manual' por el
-- DEFAULT (verificado arriba que es correcto: nació del flujo manual
-- /servicios/nuevo, antes de que "contratacion" como origen existiera).
ALTER TABLE services ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual';

ALTER TABLE services DROP CONSTRAINT IF EXISTS services_origin_check;
ALTER TABLE services ADD CONSTRAINT services_origin_check
  CHECK (origin IN ('manual', 'contratacion'));

-- Como máximo un servicio "de contratación" (el bootstrap automático) por
-- cotización — pero cualquier número de servicios 'manual' para la misma
-- cotización, cumpliendo la arquitectura definitiva "quote 1 : N services".
DROP INDEX IF EXISTS services_one_initial_per_quote;
CREATE UNIQUE INDEX services_one_initial_per_quote
  ON services (quote_id) WHERE origin = 'contratacion';


-- ---------- 4. contract_quote ----------
-- SECURITY DEFINER: necesario porque, una vez activo el freeze (archivo
-- separado, fase6-6-freeze.sql), un UPDATE que saca a la cotización de
-- lifecycle_status='cotizacion' violaría la propia policy RESTRICTIVE con
-- SECURITY INVOKER. Al ser DEFINER, esta función corre con los privilegios
-- de su dueño (en Supabase, normalmente el rol que ejecuta las migraciones
-- desde el SQL Editor, con BYPASSRLS) — dentro de su cuerpo NINGUNA policy
-- de RLS aplica, ni siquiera la RESTRICTIVE nueva. Por eso la función ES el
-- único control de seguridad en este camino, no un complemento de RLS:
--   - SET search_path fijo (evita search_path hijacking).
--   - auth.uid() obligatorio al inicio (nunca se acepta un actor por parámetro).
--   - Opera únicamente sobre el p_quote_id recibido, un solo uuid.
--   - Sin SQL dinámico, sin parámetros de "haz cualquier cosa".
--   - EXECUTE revocado de PUBLIC y otorgado únicamente a authenticated (sección 6).
-- IMPORTANTE - alcance semántico de esta función (Fase 6.6A): representa
-- EXCLUSIVAMENTE la contratación manual interna hecha por un miembro de
-- staff ya autenticado. Por eso NO existe ningún parámetro de "método": el
-- audit siempre registra 'manual_staff', porque esa es la única forma válida
-- de invocar esta RPC - no se acepta un p_method desde el cliente, ya que un
-- usuario authenticated podría enviar 'qr_publico' arbitrariamente y
-- contaminar semánticamente el audit con un origen que nunca ocurrió.
-- La futura aceptación pública por QR NO llamará a esta RPC directamente
-- como anon (nunca se le otorgará EXECUTE a anon). Esa fase futura diseñará
-- su propia entrada pública/server-side que: valide el token, valide
-- vigencia/uso, registre el acceptance_event, y ejecute o reutilice el
-- núcleo transaccional de contratación de forma segura, registrando ahí sí
-- 'qr_publico' como método real. Ese posible núcleo compartido NO se crea
-- ahora - no hay que sobrearquitecturar 6.6A para una funcionalidad que
-- todavía no existe.
CREATE OR REPLACE FUNCTION contract_quote(
  p_quote_id uuid,
  p_pdf_storage_path text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_quote quotes%ROWTYPE;
  v_is_modern boolean;
  v_expected_path text;
  v_year text;
  v_pattern text;
  v_last_folio text;
  v_next_n int;
  v_receipt_folio text;
  v_service_type text;
  v_created_service boolean := false;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'contract_quote requiere un usuario autenticado';
  END IF;

  -- Bloquea la fila durante toda la transacción: una segunda llamada
  -- concurrente sobre la MISMA cotización espera aquí hasta que la primera
  -- termine, y al reanudar ya ve el lifecycle_status actualizado.
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cotización % no encontrada', p_quote_id;
  END IF;

  IF v_quote.status <> 'cotizacion' THEN
    RAISE EXCEPTION 'La fila % no es una cotización (status=%)', p_quote_id, v_quote.status;
  END IF;

  -- Idempotencia PRIMERO: si ya está contratada, se devuelve tal cual, SIN
  -- exigir p_pdf_storage_path — un reintento que ya no lo trae no debe fallar.
  IF v_quote.lifecycle_status = 'contratado' THEN
    RETURN jsonb_build_object(
      'already_contracted', true,
      'quote_id', p_quote_id,
      'lifecycle_status', v_quote.lifecycle_status
    );
  END IF;

  IF v_quote.lifecycle_status = 'cancelado' THEN
    RAISE EXCEPTION 'La cotización % está cancelada; no puede contratarse', v_quote.folio;
  END IF;

  -- Único camino que continúa: lifecycle_status = 'cotizacion'.

  -- "Moderna" = tiene company_snapshot (Fase 5+). Esta es una regla de
  -- COMPATIBILIDAD de la arquitectura actual, no una verdad permanente —
  -- documentado aquí a propósito para quien retome esto más adelante.
  -- Deliberadamente NO se usa quote_type IS NOT NULL: legacy podría, en el
  -- futuro, adquirir un quote_type sin volverse "moderna" en el sentido de
  -- Fase 5 (snapshots congelados + PDF persistido).
  v_is_modern := v_quote.company_snapshot IS NOT NULL;

  IF v_is_modern THEN
    v_expected_path := 'quotes/' || p_quote_id::text || '/quote.pdf';
    IF p_pdf_storage_path IS NULL OR btrim(p_pdf_storage_path) = '' THEN
      RAISE EXCEPTION 'Cotización moderna: se requiere p_pdf_storage_path (el PDF debe subirse a Storage antes de llamar a esta función — ver ensureQuotePdfPersisted de Fase 6.5)';
    END IF;
    IF p_pdf_storage_path <> v_expected_path THEN
      RAISE EXCEPTION 'p_pdf_storage_path inválido: se esperaba % y se recibió %', v_expected_path, p_pdf_storage_path;
    END IF;
  END IF;
  -- Legacy: p_pdf_storage_path se ignora aunque venga informado — nunca se
  -- persiste una ruta para una cotización sin snapshot moderno. Postgres NO
  -- verifica que Storage realmente contenga esos bytes — esa garantía es
  -- responsabilidad exclusiva del caller (que ya ejecutó
  -- ensureQuotePdfPersisted con éxito antes de invocar esta función).

  UPDATE quotes SET
    contracted = true,
    lifecycle_status = 'contratado',
    pdf_storage_path = CASE WHEN v_is_modern THEN p_pdf_storage_path ELSE pdf_storage_path END
  WHERE id = p_quote_id;

  -- ---------- Recibo ----------
  IF EXISTS (SELECT 1 FROM quotes WHERE status = 'recibo' AND related_folio = v_quote.folio) THEN
    SELECT folio INTO v_receipt_folio FROM quotes
      WHERE status = 'recibo' AND related_folio = v_quote.folio LIMIT 1;
  ELSE
    -- Advisory lock exclusivo para esta sección crítica: serializa SOLO el
    -- cálculo+inserción del folio REC entre contrataciones concurrentes de
    -- cotizaciones DISTINTAS (el FOR UPDATE de arriba ya serializa
    -- reintentos sobre la MISMA cotización, pero no protege contra que dos
    -- cotizaciones diferentes calculen el mismo "siguiente" folio a la vez).
    -- Clave derivada de un texto estable, no un número mágico:
    -- 'cotizador:receipt_folio' es el único identificador de esta sección en
    -- toda la app; hashtext() lo convierte a un entero de 32 bits
    -- reproducible, el cast a bigint usa el overload
    -- pg_advisory_xact_lock(bigint). Un advisory lock transaccional se
    -- adquiere aquí y se retiene hasta el COMMIT o ROLLBACK de TODA la
    -- transacción de esta función — la contención entre contrataciones
    -- concurrentes empieza en este punto, pero el lock NO se libera al salir
    -- de este bloque PL/pgSQL (no existe tal liberación parcial); se libera
    -- automáticamente cuando la función entera termina. Nunca hace falta
    -- liberarlo a mano.
    PERFORM pg_advisory_xact_lock(hashtext('cotizador:receipt_folio')::bigint);

    v_year := extract(year from now())::text;
    v_pattern := 'REC-' || v_year || '-%';
    SELECT folio INTO v_last_folio FROM quotes
      WHERE status = 'recibo' AND folio LIKE v_pattern
      ORDER BY folio DESC LIMIT 1;
    v_next_n := COALESCE((regexp_match(v_last_folio, '-(\d+)$'))[1]::int, 0) + 1;
    v_receipt_folio := 'REC-' || v_year || '-' || lpad(v_next_n::text, 4, '0');

    -- Payload idéntico al de convertToReceipt (app/historial/page.js) hoy —
    -- sin modernizar el recibo, sin copiar snapshots ni install_time_*.
    INSERT INTO quotes (
      folio, status, receipt_status, related_folio,
      client_name, client_phone, client_email, client_address, client_id,
      items, discount_type, discount_value, notes, valid_days,
      subtotal, discount, iva, iva_rate, apply_iva, total
    ) VALUES (
      v_receipt_folio, 'recibo', 'vigente', v_quote.folio,
      v_quote.client_name, v_quote.client_phone, v_quote.client_email, v_quote.client_address, v_quote.client_id,
      v_quote.items, v_quote.discount_type, v_quote.discount_value, v_quote.notes, v_quote.valid_days,
      v_quote.subtotal, v_quote.discount, v_quote.iva, v_quote.iva_rate, v_quote.apply_iva, v_quote.total
    );
  END IF;

  -- ---------- Servicio inicial ----------
  -- origin='contratacion' + el índice único parcial de la sección 3
  -- garantizan que reintentar esta función nunca cree un segundo servicio
  -- de bootstrap, incluso si esta comprobación NOT EXISTS perdiera una
  -- carrera (el índice la respaldaría con un 23505, que abortaría la
  -- transacción en vez de duplicar).
  IF v_quote.requires_service AND NOT EXISTS (
    SELECT 1 FROM services WHERE quote_id = p_quote_id AND origin = 'contratacion'
  ) THEN
    v_service_type := CASE
      WHEN v_quote.quote_type = 'instalacion' THEN 'Instalación'
      WHEN v_quote.quote_type = 'servicio' THEN 'Servicio'
      WHEN v_quote.quote_type = 'venta' THEN 'Servicio asociado a venta'
      ELSE 'Servicio'
    END;
    INSERT INTO services (quote_id, client_id, service_type, address, origin, status)
    VALUES (
      p_quote_id, v_quote.client_id, v_service_type,
      COALESCE(NULLIF(v_quote.service_address, ''), v_quote.client_address, ''),
      'contratacion', 'pendiente_agendar'
    );
    v_created_service := true;
  END IF;

  -- Sin bloque de excepción alrededor: si este INSERT falla, toda la
  -- transacción se revierte automáticamente (comportamiento estándar de
  -- Postgres) — es la respuesta más simple y correcta a "¿debe abortar todo
  -- si audit falla?": sí, sin necesitar ninguna lógica adicional.
  -- method siempre 'manual_staff' (literal, no viene del cliente) - ver el
  -- comentario de alcance semántico arriba del CREATE FUNCTION.
  INSERT INTO audit_log (entity_type, entity_id, event_type, actor_user_id, detail)
  VALUES ('quote', p_quote_id, 'quote_contracted', v_actor,
    jsonb_build_object('method', 'manual_staff', 'folio', v_quote.folio, 'is_modern', v_is_modern));

  RETURN jsonb_build_object(
    'already_contracted', false,
    'quote_id', p_quote_id,
    'receipt_folio', v_receipt_folio,
    'created_service', v_created_service
  );
END;
$$;


-- ---------- 5. cancel_quote_contract ----------
CREATE OR REPLACE FUNCTION cancel_quote_contract(
  p_quote_id uuid,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_quote quotes%ROWTYPE;
  v_receipt_id uuid;
  v_is_modern boolean;
  v_reason text;
  v_affected jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'cancel_quote_contract requiere un usuario autenticado';
  END IF;

  -- Motivo opcional: vacío o solo espacios se normaliza a NULL. cancelled_at
  -- SIEMPRE se establece cuando la transición ocurre de verdad;
  -- cancelled_reason puede quedar NULL — ambas cosas son válidas por diseño.
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cotización % no encontrada', p_quote_id;
  END IF;

  IF v_quote.status <> 'cotizacion' THEN
    RAISE EXCEPTION 'La fila % no es una cotización (status=%)', p_quote_id, v_quote.status;
  END IF;

  -- Idempotencia: cancelar una ya cancelada no debe tocar cancelled_at otra
  -- vez, ni duplicar audit, ni volver a intentar alterar servicios.
  IF v_quote.lifecycle_status = 'cancelado' THEN
    RETURN jsonb_build_object('already_cancelled', true, 'quote_id', p_quote_id);
  END IF;

  IF v_quote.lifecycle_status = 'cotizacion' THEN
    RAISE EXCEPTION 'La cotización % no está contratada; no hay nada que cancelar', v_quote.folio;
  END IF;

  -- Único camino que continúa: lifecycle_status = 'contratado'.
  v_is_modern := v_quote.company_snapshot IS NOT NULL;

  SELECT id INTO v_receipt_id FROM quotes
    WHERE status = 'recibo' AND related_folio = v_quote.folio FOR UPDATE;

  IF v_receipt_id IS NULL THEN
    IF v_is_modern THEN
      RAISE EXCEPTION 'Inconsistencia: cotización moderna % está contratada pero no tiene recibo asociado', v_quote.folio;
    END IF;
    -- Legacy sin recibo: se acepta tal cual — nunca se inventa
    -- retroactivamente un recibo que nunca existió para datos anteriores a
    -- este sistema.
  END IF;

  UPDATE quotes SET
    lifecycle_status = 'cancelado',
    cancelled_at = now(),
    cancelled_reason = v_reason
  WHERE id = p_quote_id;

  IF v_receipt_id IS NOT NULL THEN
    UPDATE quotes SET receipt_status = 'cancelado' WHERE id = v_receipt_id;
  END IF;

  -- Solo se devuelven los servicios que EFECTIVAMENTE transicionaron ahora
  -- (el WHERE de la sub-cláusula ya excluye 'realizado' y 'cancelado'
  -- previos — nunca se reportan como recién modificados). Ningún servicio
  -- se borra, solo cambia de status.
  WITH cancelled AS (
    UPDATE services
    SET status = 'cancelado', updated_at = now()
    WHERE quote_id = p_quote_id
      AND status IN ('pendiente_agendar', 'agendado', 'confirmado')
    RETURNING id, google_event_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'google_event_id', google_event_id)), '[]'::jsonb)
  INTO v_affected
  FROM cancelled;

  INSERT INTO audit_log (entity_type, entity_id, event_type, actor_user_id, detail)
  VALUES ('quote', p_quote_id, 'quote_cancelled', v_actor,
    jsonb_build_object('reason', v_reason, 'folio', v_quote.folio, 'is_modern', v_is_modern));

  RETURN jsonb_build_object(
    'already_cancelled', false,
    'quote_id', p_quote_id,
    'affected_services', v_affected
  );
END;
$$;


-- ---------- 6. Permisos ----------
-- PostgreSQL otorga EXECUTE a PUBLIC por defecto en toda función nueva —
-- hay que revocarlo explícitamente antes de otorgar solo a authenticated,
-- para que anon (que es parte de PUBLIC) quede sin acceso.
-- Defensivo: como esta migración todavía no se ha ejecutado, la firma vieja
-- de 3 argumentos (uuid, text, text) no debería existir — pero si por
-- cualquier motivo (ej. una prueba manual previa) llegara a existir, se
-- retira explícitamente para no dejar dos versiones de contract_quote
-- coexistiendo con permisos distintos.
DROP FUNCTION IF EXISTS contract_quote(uuid, text, text);

REVOKE ALL ON FUNCTION contract_quote(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION cancel_quote_contract(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION contract_quote(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION cancel_quote_contract(uuid, text) TO authenticated;


-- ============================================================================
-- SQL DE VERIFICACIÓN — solo lectura, ejecutar después de lo anterior
-- ============================================================================

-- Confirma que el drift quedó en 0 (debía estarlo ya antes del backfill).
SELECT count(*) AS filas_con_drift FROM quotes
WHERE status = 'cotizacion' AND contracted = true AND lifecycle_status = 'cotizacion';

-- Confirma que el UNIQUE viejo ya no existe.
SELECT conname FROM pg_constraint WHERE conname = 'services_quote_id_key';
-- (debe devolver 0 filas)

-- Confirma la columna nueva y su clasificación del único servicio real.
SELECT id, quote_id, origin FROM services;
-- (debe mostrar origin='manual' en la fila existente)

-- Confirma el índice único parcial.
SELECT indexname, indexdef FROM pg_indexes WHERE indexname = 'services_one_initial_per_quote';

-- Confirma que ambas funciones existen, son SECURITY DEFINER, y su search_path.
-- Confirma también que existe UNA sola versión de contract_quote (2
-- argumentos) — que no haya quedado coexistiendo una versión vieja de 3.
SELECT proname, pronargs, prosecdef, proconfig FROM pg_proc
WHERE proname IN ('contract_quote', 'cancel_quote_contract');
-- prosecdef debe ser 't' en ambas; proconfig debe incluir "search_path=public, pg_temp";
-- contract_quote debe aparecer una sola vez, con pronargs = 2.

-- Confirma los grants exactos: authenticated debe tener EXECUTE, PUBLIC no.
SELECT routine_name, grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_name IN ('contract_quote', 'cancel_quote_contract')
ORDER BY routine_name, grantee;
-- (solo debe aparecer 'authenticated' con EXECUTE — nunca 'PUBLIC' ni 'anon')


-- ============================================================================
-- ROLLBACK MANUAL — NO EJECUTAR junto con la migración normal.
-- ============================================================================
-- DROP FUNCTION IF EXISTS contract_quote(uuid, text);
-- DROP FUNCTION IF EXISTS cancel_quote_contract(uuid, text);
-- DROP INDEX IF EXISTS services_one_initial_per_quote;
-- ALTER TABLE services DROP CONSTRAINT IF EXISTS services_origin_check;
-- ALTER TABLE services DROP COLUMN IF EXISTS origin;
-- -- Restaurar el UNIQUE retirado — SOLO si en ese momento ningún quote_id
-- -- tiene más de un servicio con origin='contratacion' (ya no existiría esa
-- -- columna si se llegó hasta aquí, así que en la práctica: solo si ningún
-- -- quote_id tiene más de una fila en total; verificar antes con:
-- --   SELECT quote_id, count(*) FROM services GROUP BY quote_id HAVING count(*) > 1;
-- -- y confirmar que devuelve 0 filas antes de este ALTER):
-- ALTER TABLE services ADD CONSTRAINT services_quote_id_key UNIQUE (quote_id);
-- -- El backfill de lifecycle_status (sección 1) NO tiene rollback razonable
-- -- ni falta hacerlo: corrige datos hacia el estado que siempre debieron
-- -- tener según su propio `contracted`, nunca los deja peor.
