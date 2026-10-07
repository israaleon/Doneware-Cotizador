-- =============================================================================
-- FASE 6.7C-1.2 — contract_quote: una cotización MODERNA sin publicación 6.7
--                 válida ya NO se puede contratar
-- =============================================================================
--
-- ESTADO: ARCHIVO PARA REVISIÓN. No ejecutado. Ejecutar solo después de
-- revisarlo, por secciones y en orden A -> B -> C. No modifica ni reemplaza
-- fase6-7c0-contract-quote.sql (que queda como registro histórico de 6.7C-0).
--
-- DECISIÓN QUE IMPLEMENTA (alternativa 1 de 6.7C-1.1)
-- ---------------------------------------------------
-- A partir de 6.7 no existe una "moderna sin revisión" contratable:
--   * "Moderna"  = company_snapshot IS NOT NULL (definición que se conserva).
--   * Moderna NO publicada = moderna con content_revision IS NULL
--     -> NO CONTRATABLE: contract_quote lanza una excepción clara.
--   * Moderna publicada = moderna con content_revision IS NOT NULL
--     -> se contrata solo si siguen cumpliéndose las validaciones de 6.7C-0
--     (published_snapshot válido, pdf_storage_path exactamente
--     quotes/<id>/revisions/<content_revision>.pdf, y p_pdf_storage_path,
--     si viene informado, idéntico a esa ruta).
--   * Legacy puro = company_snapshot IS NULL -> comportamiento histórico
--     intacto.
-- Motivo: content_revision IS NULL ya no distingue una moderna histórica
-- legítima (6.6) de una creada por 6.7 cuya primera publicación falló; ambas
-- son ahora "no publicada" y deben publicarse (abrirse y guardarse con el
-- flujo 6.7) antes de contratarse.
--
-- BASE DE ESTE CAMBIO
-- -------------------
-- La definición de partida es la versión 6.7C-0 (Sección B de
-- fase6-7c0-contract-quote.sql), NO la de 6.6. El único respaldo
-- AUTORITATIVO es el resultado de A.0 capturado en producción justo antes
-- de ejecutar B.
--
-- QUÉ CAMBIA EN contract_quote (diff conceptual mínimo)
-- -----------------------------------------------------
--   [1] La rama "moderna SIN revisión" (antes: exigía p_pdf_storage_path,
--       lo comparaba contra la ruta canónica legacy y la escribía) ahora
--       solo lanza la excepción "cotización moderna no publicada". No
--       construye ninguna ruta canónica, no acepta p_pdf_storage_path, no
--       escribe pdf_storage_path y falla ANTES del UPDATE contractual (no hay
--       contratación, recibo, servicio ni audit).
--   [2] El UPDATE contractual deja de contener la asignación de
--       pdf_storage_path (en ningún camino se escribe ya): para una revisión
--       publicada nunca se escribía, y la moderna sin revisión ya no llega
--       hasta aquí. Para legacy puro era un no-op (ELSE pdf_storage_path).
--   [3] Se actualiza el comentario del camino legacy (ya no hay caller que
--       suba un PDF antes de contratar).
-- Idéntico a 6.7C-0: firma y defaults, SECURITY DEFINER, search_path,
-- auth.uid(), FOR UPDATE, status, idempotencia (contratado) y rechazo de
-- cancelada ANTES de las validaciones de publicación, guard de fila no
-- moderna con content_revision, rama de revisión publicada, recibo desde
-- columnas vivas, advisory lock de folio, servicio inicial, audit
-- (manual_staff) y RETURN.
--
-- CONSECUENCIA HISTÓRICA ACEPTADA
-- -------------------------------
-- COT-2026-0003 (moderna, precontractual, sin publicación) deja de poder
-- contratarse por el camino 6.6. Debe abrirse y guardarse con el flujo 6.7
-- (primera publicación) y después podrá contratarse. No hay excepción para
-- ese folio ni se modifica ningún dato.
--
-- ORDEN DE DESPLIEGUE (importante)
-- --------------------------------
-- La app con publicación 6.7C-1 / 1.1 / 1.2 debe estar DESPLEGADA antes de
-- ejecutar B. Con la app anterior, guardar una cotización NO produce
-- content_revision: ninguna moderna podría publicarse y, tras B, ninguna
-- moderna precontractual podría contratarse.
--
-- PERMISOS
-- --------
-- CREATE OR REPLACE FUNCTION conserva dueño y grants; este archivo no
-- incluye GRANT/REVOKE y C verifica que quedaron idénticos.
-- =============================================================================


-- #############################################################################
-- SECCIÓN A — PRECHECKS (solo lectura). Ejecutar COMPLETA y leer cada
--             resultado ANTES de pasar a la SECCIÓN B.
-- #############################################################################
-- Verificación manual previa (no se puede comprobar por SQL): la app con
-- 6.7C-1.2 ya está desplegada (ver "ORDEN DE DESPLIEGUE"). DETENTE SI no lo está.

-- A.0: RESPALDO = ROLLBACK AUTORITATIVO. Copia el resultado COMPLETO de esta
-- consulta a un archivo aparte ANTES de ejecutar la SECCIÓN B: es la
-- definición exacta desplegada inmediatamente antes de 6.7C-1.2 y es lo que
-- se ejecuta para revertir. La copia comentada de la SECCIÓN D (6.7C-0) es
-- solo referencia/fallback; si difiere de A.0, PREVALECE A.0.
SELECT pg_get_functiondef('public.contract_quote(uuid, text)'::regprocedure) AS definicion_actual_contract_quote;
-- DETENTE SI: no guardaste este resultado. No ejecutes B sin ese respaldo.

-- A.1: una sola contract_quote, con firma, seguridad, search_path y dueño esperados.
SELECT p.oid::regprocedure AS firma,
       pg_get_function_arguments(p.oid) AS argumentos,
       p.prosecdef AS security_definer,
       p.proconfig AS config,
       pg_get_userbyid(p.proowner) AS dueno
FROM pg_proc p
WHERE p.proname = 'contract_quote' AND p.pronamespace = 'public'::regnamespace;
-- Esperado: EXACTAMENTE 1 fila; argumentos = 'p_quote_id uuid, p_pdf_storage_path text DEFAULT NULL::text';
--           security_definer = t; config incluye 'search_path=public, pg_temp'.
-- ANOTA el dueño y la config: C.1 debe devolverlos idénticos.
-- DETENTE SI: 0 filas, más de 1, argumentos distintos, security_definer = f o
-- config sin el search_path esperado.

-- A.2: la función desplegada es la de 6.7C-0 (todavía NO la de 6.7C-1.2).
-- Se buscan fragmentos semánticos SEPARADOS (position), no una frase con
-- formato exacto: el espaciado de pg_get_functiondef no importa.
SELECT
  position('/revisions/'              in def) > 0 AS tiene_ruta_revision,
  position('/quote.pdf'               in def) > 0 AS tiene_ruta_canonica_6_6,
  position('content_revision'         in def) > 0 AS tiene_logica_6_7c0,
  position('moderna no publicada'     in def) > 0 AS ya_tiene_rechazo_6_7c1_2,
  position('pg_advisory_xact_lock'    in def) > 0 AS tiene_advisory_lock,
  position('cotizador:receipt_folio'  in def) > 0 AS tiene_clave_lock_folio,
  position('manual_staff'             in def) > 0 AS tiene_audit_manual_staff,
  position('quote_contracted'         in def) > 0 AS tiene_evento_audit,
  position('already_contracted'       in def) > 0 AS tiene_idempotencia,
  position('FOR UPDATE'               in def) > 0 AS tiene_for_update
FROM (SELECT pg_get_functiondef(p.oid) AS def
        FROM pg_proc p
       WHERE p.proname = 'contract_quote' AND p.pronamespace = 'public'::regnamespace) d;
-- Esperado: t, t, t, f, t, t, t, t, t, t.
-- DETENTE SI: tiene_ruta_revision = f o tiene_logica_6_7c0 = f (6.7C-0 no está
-- desplegada: no es la base de este cambio); ya_tiene_rechazo_6_7c1_2 = t
-- (ya se aplicó: no repetir); cualquiera de los demás = f (la función
-- desplegada fue editada a mano: compara con A.0 antes de reemplazar).

-- A.3: permisos REALES actuales (deben quedar idénticos tras B).
SELECT p.oid::regprocedure AS firma,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_ejecuta,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_ejecuta,
       (SELECT COALESCE(bool_or(a.grantee = 0), false)
          FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a) AS public_ejecuta
FROM pg_proc p
WHERE p.proname IN ('contract_quote', 'cancel_quote_contract')
  AND p.pronamespace = 'public'::regnamespace
ORDER BY 1;
-- Esperado en ambas funciones: anon_ejecuta = f, authenticated_ejecuta = t, public_ejecuta = f.
-- DETENTE SI: anon_ejecuta = t o public_ejecuta = t (exposición previa a
-- corregir por separado) o authenticated_ejecuta = f.

-- A.4: las columnas de las que depende esta función existen.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'quotes'
  AND column_name IN ('company_snapshot', 'content_revision', 'published_snapshot', 'pdf_storage_path')
ORDER BY column_name;
-- Esperado: 4 filas (company_snapshot jsonb, content_revision uuid,
-- pdf_storage_path text, published_snapshot jsonb).
-- DETENTE SI: falta alguna.

-- A.5: estado de COT-2026-0003 (informativo: tras B quedará NO contratable
-- hasta publicarse; no se modifica).
SELECT folio, status, lifecycle_status, contracted,
       (company_snapshot IS NOT NULL)  AS es_moderna,
       content_revision,
       (published_snapshot IS NOT NULL) AS tiene_snapshot_publicado,
       pdf_storage_path, valid_until
FROM quotes
WHERE folio = 'COT-2026-0003';
-- Esperado hoy: es_moderna = t, content_revision NULL, tiene_snapshot_publicado = f.
-- Si ya tuviera content_revision (se publicó antes de B), seguiría contratable.

-- A.6: CLASIFICACIÓN de todas las filas según la nueva regla. Muestra qué
-- quedará NO contratable y detecta inconsistencias que 6.7C-0 ya rechaza.
WITH clasificadas AS (
  SELECT
    q.folio,
    (q.status = 'cotizacion' AND q.lifecycle_status = 'cotizacion') AS precontractual,
    CASE
      WHEN q.status <> 'cotizacion' THEN
        CASE WHEN q.content_revision IS NULL AND q.published_snapshot IS NULL AND q.pdf_storage_path IS NULL
             THEN 'NO_APLICA_RECIBO'
             ELSE 'REVISAR_FILA_NO_COTIZACION_CON_PUBLICACION' END
      WHEN q.company_snapshot IS NULL AND q.content_revision IS NULL
        THEN 'LEGACY_PURO'
      WHEN q.company_snapshot IS NULL
        THEN 'INCONSISTENTE_REVISION_EN_NO_MODERNA'
      WHEN q.content_revision IS NULL
        THEN 'MODERNA_NO_PUBLICADA'
      WHEN q.published_snapshot IS NOT NULL AND jsonb_typeof(q.published_snapshot) = 'object'
           AND q.pdf_storage_path = 'quotes/' || q.id::text || '/revisions/' || q.content_revision::text || '.pdf'
        THEN 'MODERNA_PUBLICADA_COHERENTE'
      WHEN q.pdf_storage_path IS NULL OR btrim(q.pdf_storage_path) = ''
        THEN 'INCONSISTENTE_REVISION_SIN_PATH'
      WHEN q.published_snapshot IS NULL OR jsonb_typeof(q.published_snapshot) <> 'object'
        THEN 'INCONSISTENTE_REVISION_SIN_SNAPSHOT_VALIDO'
      ELSE 'INCONSISTENTE_REVISION_PATH_NO_CORRESPONDE'
    END AS categoria
  FROM quotes q
)
SELECT categoria, precontractual, count(*) AS filas,
       string_agg(folio, ', ' ORDER BY folio) AS folios
FROM clasificadas
GROUP BY categoria, precontractual
ORDER BY categoria, precontractual DESC;
-- Esperado hoy: LEGACY_PURO y NO_APLICA_RECIBO; MODERNA_NO_PUBLICADA con
-- precontractual = t únicamente para COT-2026-0003; y, si existen,
-- MODERNA_PUBLICADA_COHERENTE. Un pdf_storage_path canónico en una
-- MODERNA_NO_PUBLICADA no cambia nada (esta fase no toca datos).
-- DETENTE SI:
--   * MODERNA_NO_PUBLICADA con precontractual = t incluye folios que NO
--     esperabas o que necesitas contratar hoy mismo: quedarán no
--     contratables hasta publicarse. Publícalas primero (con la app
--     desplegada) o decide conscientemente aceptarlo.
-- REVISAR (no bloquea B; 6.7C-0 ya las rechaza al contratar):
--   * cualquier INCONSISTENTE_* y REVISAR_FILA_NO_COTIZACION_CON_PUBLICACION.

-- A.7: HUELLAS para comparar después (guárdalas).
SELECT
  (SELECT md5(pg_get_functiondef('public.cancel_quote_contract(uuid, text)'::regprocedure))) AS md5_cancel_quote_contract,
  (SELECT count(*) FROM quotes)   AS total_quotes,
  (SELECT count(*) FROM services) AS total_services,
  (SELECT count(*) FROM audit_log) AS total_audit_log,
  (SELECT md5(string_agg(id::text || ':' || COALESCE(lifecycle_status::text, '-') || ':' || COALESCE(pdf_storage_path, '-') || ':' || COALESCE(content_revision::text, '-'),
                         ',' ORDER BY id))
     FROM quotes) AS huella_quotes,
  (SELECT md5(string_agg(policyname || '|' || cmd || '|' || permissive || '|' || COALESCE(qual, '') || '|' || COALESCE(with_check, ''),
                         ',' ORDER BY policyname))
     FROM pg_policies WHERE schemaname = 'public' AND tablename = 'quotes') AS huella_politicas_quotes;
-- Anota los 6 valores. La SECCIÓN C debe devolverlos IDÉNTICOS.


-- #############################################################################
-- SECCIÓN B — REEMPLAZO DE contract_quote (una sola sentencia, atómica).
--             Ejecutar SOLO si toda la SECCIÓN A pasó sin DETENTE SI y
--             guardaste A.0.
-- #############################################################################
-- Cuerpo = 6.7C-0 (versión desplegada) salvo los puntos marcados "[6.7C-1.2]".

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

  -- [6.7C-0] (punto 2) Guard defensivo: una revisión publicada solo existe
  -- en cotizaciones modernas. Una fila legacy (sin company_snapshot) con
  -- content_revision es una inconsistencia — no se contrata en silencio.
  IF NOT v_is_modern AND v_quote.content_revision IS NOT NULL THEN
    RAISE EXCEPTION 'Inconsistencia: la cotización % tiene content_revision pero no es moderna (sin company_snapshot); no puede contratarse', v_quote.folio;
  END IF;

  -- [6.7C-0] (punto 1) Bifurcación por content_revision.
  IF v_is_modern AND v_quote.content_revision IS NOT NULL THEN
    -- ---- Moderna con revisión publicada (Fase 6.7) ----
    -- La FILA bloqueada (FOR UPDATE arriba) es la autoridad: content_revision,
    -- published_snapshot y pdf_storage_path ya fueron publicados juntos. La
    -- ruta esperada se reconstruye aquí con el id REAL de la fila y su
    -- revisión REAL — nunca a partir de lo que mande el navegador.
    v_expected_path := 'quotes/' || p_quote_id::text || '/revisions/' || v_quote.content_revision::text || '.pdf';

    IF v_quote.pdf_storage_path IS NULL OR btrim(v_quote.pdf_storage_path) = '' THEN
      RAISE EXCEPTION 'Inconsistencia: la cotización % tiene content_revision % pero no tiene pdf_storage_path publicado', v_quote.folio, v_quote.content_revision;
    END IF;
    IF v_quote.published_snapshot IS NULL OR jsonb_typeof(v_quote.published_snapshot) <> 'object' THEN
      RAISE EXCEPTION 'Inconsistencia: la cotización % tiene content_revision % pero no tiene published_snapshot válido', v_quote.folio, v_quote.content_revision;
    END IF;
    IF v_quote.pdf_storage_path <> v_expected_path THEN
      RAISE EXCEPTION 'Inconsistencia: pdf_storage_path (%) no corresponde a la revisión publicada; se esperaba %', v_quote.pdf_storage_path, v_expected_path;
    END IF;
    -- p_pdf_storage_path es solo una confirmación opcional del cliente: si
    -- viene, debe ser EXACTAMENTE la revisión publicada (así un cliente con
    -- una revisión obsoleta falla de forma explícita en vez de contratar sin
    -- saberlo otra revisión). Si viene NULL se acepta: la autoridad es la fila.
    IF p_pdf_storage_path IS NOT NULL AND p_pdf_storage_path <> v_expected_path THEN
      RAISE EXCEPTION 'p_pdf_storage_path (%) no coincide con la revisión publicada de la cotización (esperada %)', p_pdf_storage_path, v_expected_path;
    END IF;
  ELSIF v_is_modern THEN
    -- [6.7C-1.2] ---- Moderna SIN publicación 6.7: NO CONTRATABLE ----
    -- Ya no existe un camino contractual para una moderna sin revisión:
    -- no se acepta p_pdf_storage_path, no se construye ninguna ruta
    -- canónica y no se escribe pdf_storage_path. Se falla AQUÍ, antes del
    -- UPDATE contractual, así que no hay contratación, recibo, servicio ni
    -- audit. (La idempotencia de una ya contratada y el rechazo de una
    -- cancelada ocurren más arriba, antes de esta validación.)
    RAISE EXCEPTION 'Cotización moderna no publicada: la cotización % no tiene content_revision (no existe una publicación 6.7 válida); ábrela y guárdala para publicar su primera revisión antes de contratarla', v_quote.folio;
  END IF;
  -- [6.7C-1.2] Legacy puro (sin company_snapshot): p_pdf_storage_path se
  -- ignora aunque venga informado — nunca se persiste una ruta para una
  -- cotización sin snapshot moderno. Este camino no escribe pdf_storage_path.

  -- [6.7C-1.2] La contratación ya no escribe pdf_storage_path en ningún camino:
  -- una revisión publicada conserva el suyo y la moderna sin revisión es
  -- rechazada más arriba, antes de llegar aquí.
  UPDATE quotes SET
    contracted = true,
    lifecycle_status = 'contratado'
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


-- #############################################################################
-- SECCIÓN C — VERIFICACIONES POSTERIORES (solo lectura). Ejecutar completa
--             después de B y comparar contra la SECCIÓN A.
-- #############################################################################

-- C.1: sigue habiendo UNA sola contract_quote; firma/seguridad/config/dueño
-- IDÉNTICOS a A.1.
SELECT p.oid::regprocedure AS firma,
       pg_get_function_arguments(p.oid) AS argumentos,
       p.prosecdef AS security_definer,
       p.proconfig AS config,
       pg_get_userbyid(p.proowner) AS dueno
FROM pg_proc p
WHERE p.proname = 'contract_quote' AND p.pronamespace = 'public'::regnamespace;
-- DETENTE SI: difiere de A.1 en cualquier columna -> ROLLBACK (sección D).

-- C.2: permisos IDÉNTICOS a A.3.
SELECT p.oid::regprocedure AS firma,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_ejecuta,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_ejecuta,
       (SELECT COALESCE(bool_or(a.grantee = 0), false)
          FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a) AS public_ejecuta
FROM pg_proc p
WHERE p.proname IN ('contract_quote', 'cancel_quote_contract')
  AND p.pronamespace = 'public'::regnamespace
ORDER BY 1;
-- DETENTE SI: cualquier valor cambió respecto a A.3 -> ROLLBACK.

-- C.3: contenido de la nueva definición (fragmentos semánticos separados,
-- no una frase con formato exacto).
SELECT
  position('/revisions/'             in def) > 0 AS conserva_ruta_revision,
  position('moderna no publicada'    in def) > 0 AS tiene_rechazo_moderna_no_publicada,
  position('/quote.pdf'              in def) = 0 AS ya_no_construye_ruta_canonica,
  position('p_pdf_storage_path inválido' in def) = 0 AS ya_no_valida_parametro_legacy,
  position('ensureQuotePdfPersisted' in def) = 0 AS ya_no_depende_de_subir_pdf_antes,
  (def !~* 'update\s+quotes\s+set[^;]*pdf_storage_path') AS update_no_escribe_pdf_storage_path,
  position('pg_advisory_xact_lock'   in def) > 0 AS conserva_advisory_lock,
  position('cotizador:receipt_folio' in def) > 0 AS conserva_clave_lock_folio,
  position('manual_staff'            in def) > 0 AS conserva_audit_manual_staff,
  position('quote_contracted'        in def) > 0 AS conserva_evento_audit,
  position('FOR UPDATE'              in def) > 0 AS conserva_for_update,
  -- orden semántico: idempotencia y rechazo de cancelada ANTES de cualquier
  -- validación de publicación (la primera mención de content_revision es ya
  -- la validación de publicación).
  position('already_contracted' in def) > 0
    AND position('already_contracted' in def) < position('content_revision' in def) AS idempotencia_antes_de_publicacion,
  position('está cancelada' in def) > 0
    AND position('está cancelada' in def) < position('content_revision' in def) AS cancelada_antes_de_publicacion
FROM (SELECT pg_get_functiondef(p.oid) AS def
        FROM pg_proc p
       WHERE p.proname = 'contract_quote' AND p.pronamespace = 'public'::regnamespace) d;
-- Esperado: TODAS t (13 columnas).
-- DETENTE SI: cualquiera es f -> ROLLBACK (sección D).

-- C.4: HUELLAS idénticas a A.7 (la migración no escribe datos, no toca
-- cancel_quote_contract ni las políticas).
SELECT
  (SELECT md5(pg_get_functiondef('public.cancel_quote_contract(uuid, text)'::regprocedure))) AS md5_cancel_quote_contract,
  (SELECT count(*) FROM quotes)   AS total_quotes,
  (SELECT count(*) FROM services) AS total_services,
  (SELECT count(*) FROM audit_log) AS total_audit_log,
  (SELECT md5(string_agg(id::text || ':' || COALESCE(lifecycle_status::text, '-') || ':' || COALESCE(pdf_storage_path, '-') || ':' || COALESCE(content_revision::text, '-'),
                         ',' ORDER BY id))
     FROM quotes) AS huella_quotes,
  (SELECT md5(string_agg(policyname || '|' || cmd || '|' || permissive || '|' || COALESCE(qual, '') || '|' || COALESCE(with_check, ''),
                         ',' ORDER BY policyname))
     FROM pg_policies WHERE schemaname = 'public' AND tablename = 'quotes') AS huella_politicas_quotes;
-- DETENTE SI: cualquiera de los 6 valores difiere de A.7 -> ROLLBACK.

-- C.5: el freeze de 6.6 sigue activo (políticas RESTRICTIVE presentes; su
-- huella ya está cubierta por C.4).
SELECT policyname, permissive, cmd
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'quotes'
  AND policyname IN ('quotes_update_lock', 'quotes_delete_lock')
ORDER BY policyname;
-- Esperado: 2 filas, permissive = RESTRICTIVE, cmd = UPDATE / DELETE.

-- C.6: COT-2026-0003 NO fue modificada (misma fila que en A.5).
SELECT folio, lifecycle_status, contracted, content_revision, pdf_storage_path
FROM quotes WHERE folio = 'COT-2026-0003';
-- Esperado: idéntico a A.5. Para contratarla: abrirla, guardarla con la app
-- 6.7 (primera publicación) y luego "Marcar contratado".


-- =============================================================================
-- PRUEBAS FUNCIONALES — PENDIENTES / NO EJECUTADAS
-- =============================================================================
-- No se ejecutaron (ni aquí ni en ningún entorno). Casos a cubrir cuando se
-- autorice, con una sesión authenticated real:
--   N1  moderna + content_revision NULL (p NULL o cualquier valor) -> excepción
--       "moderna no publicada"; sin cambios de lifecycle, recibo, servicio ni audit.
--   N2  moderna + revisión coherente -> contrata (rama 6.7C-0, sin cambios).
--   N3  legacy puro (sin company_snapshot) -> contrata como siempre.
--   N4  ya contratada (aunque sea moderna sin revisión) -> already_contracted
--       idempotente (la idempotencia va antes de la validación de publicación).
--   N5  cancelada -> rechazo existente.
--   N6  fila no moderna con content_revision -> excepción (guard de 6.7C-0).


-- #############################################################################
-- SECCIÓN D — ROLLBACK MANUAL (NO ejecutar junto con la migración).
-- #############################################################################
-- ROLLBACK AUTORITATIVO: el resultado de A.0 (pg_get_functiondef de
-- public.contract_quote(uuid, text)) capturado en producción inmediatamente
-- ANTES de ejecutar B. Para revertir, ejecuta ese texto guardado (es un
-- CREATE OR REPLACE FUNCTION completo). CREATE OR REPLACE conserva dueño y
-- grants.
--
-- La copia comentada de abajo es la versión 6.7C-0 y es SOLO
-- referencia/fallback: si difiere de A.0, PREVALECE A.0.
--
-- Después del rollback ejecutar C.1, C.2 y C.4: deben dar lo mismo que A.1,
-- A.3 y A.7. (C.3 ya no aplica: la función volvería a ser la de 6.7C-0.)
-- Importante: tras el rollback una moderna sin revisión vuelve a poder
-- contratarse por la ruta canónica legacy.
--
-- CREATE OR REPLACE FUNCTION contract_quote(
--   p_quote_id uuid,
--   p_pdf_storage_path text DEFAULT NULL
-- ) RETURNS jsonb
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public, pg_temp
-- AS $$
-- DECLARE
--   v_actor uuid;
--   v_quote quotes%ROWTYPE;
--   v_is_modern boolean;
--   v_expected_path text;
--   v_year text;
--   v_pattern text;
--   v_last_folio text;
--   v_next_n int;
--   v_receipt_folio text;
--   v_service_type text;
--   v_created_service boolean := false;
-- BEGIN
--   v_actor := auth.uid();
--   IF v_actor IS NULL THEN
--     RAISE EXCEPTION 'contract_quote requiere un usuario autenticado';
--   END IF;
--
--   -- Bloquea la fila durante toda la transacción: una segunda llamada
--   -- concurrente sobre la MISMA cotización espera aquí hasta que la primera
--   -- termine, y al reanudar ya ve el lifecycle_status actualizado.
--   SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
--   IF NOT FOUND THEN
--     RAISE EXCEPTION 'Cotización % no encontrada', p_quote_id;
--   END IF;
--
--   IF v_quote.status <> 'cotizacion' THEN
--     RAISE EXCEPTION 'La fila % no es una cotización (status=%)', p_quote_id, v_quote.status;
--   END IF;
--
--   -- Idempotencia PRIMERO: si ya está contratada, se devuelve tal cual, SIN
--   -- exigir p_pdf_storage_path — un reintento que ya no lo trae no debe fallar.
--   IF v_quote.lifecycle_status = 'contratado' THEN
--     RETURN jsonb_build_object(
--       'already_contracted', true,
--       'quote_id', p_quote_id,
--       'lifecycle_status', v_quote.lifecycle_status
--     );
--   END IF;
--
--   IF v_quote.lifecycle_status = 'cancelado' THEN
--     RAISE EXCEPTION 'La cotización % está cancelada; no puede contratarse', v_quote.folio;
--   END IF;
--
--   -- Único camino que continúa: lifecycle_status = 'cotizacion'.
--
--   -- "Moderna" = tiene company_snapshot (Fase 5+). Esta es una regla de
--   -- COMPATIBILIDAD de la arquitectura actual, no una verdad permanente —
--   -- documentado aquí a propósito para quien retome esto más adelante.
--   -- Deliberadamente NO se usa quote_type IS NOT NULL: legacy podría, en el
--   -- futuro, adquirir un quote_type sin volverse "moderna" en el sentido de
--   -- Fase 5 (snapshots congelados + PDF persistido).
--   v_is_modern := v_quote.company_snapshot IS NOT NULL;
--
--   -- [6.7C-0] (punto 2) Guard defensivo: una revisión publicada solo existe
--   -- en cotizaciones modernas. Una fila legacy (sin company_snapshot) con
--   -- content_revision es una inconsistencia — no se contrata en silencio.
--   IF NOT v_is_modern AND v_quote.content_revision IS NOT NULL THEN
--     RAISE EXCEPTION 'Inconsistencia: la cotización % tiene content_revision pero no es moderna (sin company_snapshot); no puede contratarse', v_quote.folio;
--   END IF;
--
--   -- [6.7C-0] (punto 1) Bifurcación por content_revision.
--   IF v_is_modern AND v_quote.content_revision IS NOT NULL THEN
--     -- ---- Moderna con revisión publicada (Fase 6.7) ----
--     -- La FILA bloqueada (FOR UPDATE arriba) es la autoridad: content_revision,
--     -- published_snapshot y pdf_storage_path ya fueron publicados juntos. La
--     -- ruta esperada se reconstruye aquí con el id REAL de la fila y su
--     -- revisión REAL — nunca a partir de lo que mande el navegador.
--     v_expected_path := 'quotes/' || p_quote_id::text || '/revisions/' || v_quote.content_revision::text || '.pdf';
--
--     IF v_quote.pdf_storage_path IS NULL OR btrim(v_quote.pdf_storage_path) = '' THEN
--       RAISE EXCEPTION 'Inconsistencia: la cotización % tiene content_revision % pero no tiene pdf_storage_path publicado', v_quote.folio, v_quote.content_revision;
--     END IF;
--     IF v_quote.published_snapshot IS NULL OR jsonb_typeof(v_quote.published_snapshot) <> 'object' THEN
--       RAISE EXCEPTION 'Inconsistencia: la cotización % tiene content_revision % pero no tiene published_snapshot válido', v_quote.folio, v_quote.content_revision;
--     END IF;
--     IF v_quote.pdf_storage_path <> v_expected_path THEN
--       RAISE EXCEPTION 'Inconsistencia: pdf_storage_path (%) no corresponde a la revisión publicada; se esperaba %', v_quote.pdf_storage_path, v_expected_path;
--     END IF;
--     -- p_pdf_storage_path es solo una confirmación opcional del cliente: si
--     -- viene, debe ser EXACTAMENTE la revisión publicada (así un cliente con
--     -- una revisión obsoleta falla de forma explícita en vez de contratar sin
--     -- saberlo otra revisión). Si viene NULL se acepta: la autoridad es la fila.
--     IF p_pdf_storage_path IS NOT NULL AND p_pdf_storage_path <> v_expected_path THEN
--       RAISE EXCEPTION 'p_pdf_storage_path (%) no coincide con la revisión publicada de la cotización (esperada %)', p_pdf_storage_path, v_expected_path;
--     END IF;
--   ELSIF v_is_modern THEN
--     -- ---- Moderna SIN revisión (comportamiento 6.6, intacto) ----
--     v_expected_path := 'quotes/' || p_quote_id::text || '/quote.pdf';
--     IF p_pdf_storage_path IS NULL OR btrim(p_pdf_storage_path) = '' THEN
--       RAISE EXCEPTION 'Cotización moderna: se requiere p_pdf_storage_path (el PDF debe subirse a Storage antes de llamar a esta función — ver ensureQuotePdfPersisted de Fase 6.5)';
--     END IF;
--     IF p_pdf_storage_path <> v_expected_path THEN
--       RAISE EXCEPTION 'p_pdf_storage_path inválido: se esperaba % y se recibió %', v_expected_path, p_pdf_storage_path;
--     END IF;
--     -- [6.7C-0] Guard defensivo: sin revisión, un pdf_storage_path ya
--     -- existente solo puede ser la ruta canónica; cualquier otra (p. ej. una
--     -- ruta de revisión con content_revision en NULL) sería sobrescrita por la
--     -- canónica en el UPDATE de abajo — se rechaza en vez de reemplazarla.
--     IF v_quote.pdf_storage_path IS NOT NULL AND v_quote.pdf_storage_path <> v_expected_path THEN
--       RAISE EXCEPTION 'Inconsistencia: la cotización % tiene pdf_storage_path (%) distinto de la ruta canónica pero no tiene content_revision', v_quote.folio, v_quote.pdf_storage_path;
--     END IF;
--   END IF;
--   -- Legacy: p_pdf_storage_path se ignora aunque venga informado — nunca se
--   -- persiste una ruta para una cotización sin snapshot moderno. Postgres NO
--   -- verifica que Storage realmente contenga esos bytes — esa garantía es
--   -- responsabilidad exclusiva del caller (que ya ejecutó
--   -- ensureQuotePdfPersisted con éxito antes de invocar esta función).
--
--   -- [6.7C-0] (punto 3) Solo el camino 6.6 (moderna sin revisión) escribe
--   -- p_pdf_storage_path. Con revisión publicada, pdf_storage_path NO se toca.
--   UPDATE quotes SET
--     contracted = true,
--     lifecycle_status = 'contratado',
--     pdf_storage_path = CASE WHEN v_is_modern AND v_quote.content_revision IS NULL THEN p_pdf_storage_path ELSE pdf_storage_path END
--   WHERE id = p_quote_id;
--
--   -- ---------- Recibo ----------
--   IF EXISTS (SELECT 1 FROM quotes WHERE status = 'recibo' AND related_folio = v_quote.folio) THEN
--     SELECT folio INTO v_receipt_folio FROM quotes
--       WHERE status = 'recibo' AND related_folio = v_quote.folio LIMIT 1;
--   ELSE
--     -- Advisory lock exclusivo para esta sección crítica: serializa SOLO el
--     -- cálculo+inserción del folio REC entre contrataciones concurrentes de
--     -- cotizaciones DISTINTAS (el FOR UPDATE de arriba ya serializa
--     -- reintentos sobre la MISMA cotización, pero no protege contra que dos
--     -- cotizaciones diferentes calculen el mismo "siguiente" folio a la vez).
--     -- Clave derivada de un texto estable, no un número mágico:
--     -- 'cotizador:receipt_folio' es el único identificador de esta sección en
--     -- toda la app; hashtext() lo convierte a un entero de 32 bits
--     -- reproducible, el cast a bigint usa el overload
--     -- pg_advisory_xact_lock(bigint). Un advisory lock transaccional se
--     -- adquiere aquí y se retiene hasta el COMMIT o ROLLBACK de TODA la
--     -- transacción de esta función — la contención entre contrataciones
--     -- concurrentes empieza en este punto, pero el lock NO se libera al salir
--     -- de este bloque PL/pgSQL (no existe tal liberación parcial); se libera
--     -- automáticamente cuando la función entera termina. Nunca hace falta
--     -- liberarlo a mano.
--     PERFORM pg_advisory_xact_lock(hashtext('cotizador:receipt_folio')::bigint);
--
--     v_year := extract(year from now())::text;
--     v_pattern := 'REC-' || v_year || '-%';
--     SELECT folio INTO v_last_folio FROM quotes
--       WHERE status = 'recibo' AND folio LIKE v_pattern
--       ORDER BY folio DESC LIMIT 1;
--     v_next_n := COALESCE((regexp_match(v_last_folio, '-(\d+)$'))[1]::int, 0) + 1;
--     v_receipt_folio := 'REC-' || v_year || '-' || lpad(v_next_n::text, 4, '0');
--
--     -- Payload idéntico al de convertToReceipt (app/historial/page.js) hoy —
--     -- sin modernizar el recibo, sin copiar snapshots ni install_time_*.
--     INSERT INTO quotes (
--       folio, status, receipt_status, related_folio,
--       client_name, client_phone, client_email, client_address, client_id,
--       items, discount_type, discount_value, notes, valid_days,
--       subtotal, discount, iva, iva_rate, apply_iva, total
--     ) VALUES (
--       v_receipt_folio, 'recibo', 'vigente', v_quote.folio,
--       v_quote.client_name, v_quote.client_phone, v_quote.client_email, v_quote.client_address, v_quote.client_id,
--       v_quote.items, v_quote.discount_type, v_quote.discount_value, v_quote.notes, v_quote.valid_days,
--       v_quote.subtotal, v_quote.discount, v_quote.iva, v_quote.iva_rate, v_quote.apply_iva, v_quote.total
--     );
--   END IF;
--
--   -- ---------- Servicio inicial ----------
--   -- origin='contratacion' + el índice único parcial de la sección 3
--   -- garantizan que reintentar esta función nunca cree un segundo servicio
--   -- de bootstrap, incluso si esta comprobación NOT EXISTS perdiera una
--   -- carrera (el índice la respaldaría con un 23505, que abortaría la
--   -- transacción en vez de duplicar).
--   IF v_quote.requires_service AND NOT EXISTS (
--     SELECT 1 FROM services WHERE quote_id = p_quote_id AND origin = 'contratacion'
--   ) THEN
--     v_service_type := CASE
--       WHEN v_quote.quote_type = 'instalacion' THEN 'Instalación'
--       WHEN v_quote.quote_type = 'servicio' THEN 'Servicio'
--       WHEN v_quote.quote_type = 'venta' THEN 'Servicio asociado a venta'
--       ELSE 'Servicio'
--     END;
--     INSERT INTO services (quote_id, client_id, service_type, address, origin, status)
--     VALUES (
--       p_quote_id, v_quote.client_id, v_service_type,
--       COALESCE(NULLIF(v_quote.service_address, ''), v_quote.client_address, ''),
--       'contratacion', 'pendiente_agendar'
--     );
--     v_created_service := true;
--   END IF;
--
--   -- Sin bloque de excepción alrededor: si este INSERT falla, toda la
--   -- transacción se revierte automáticamente (comportamiento estándar de
--   -- Postgres) — es la respuesta más simple y correcta a "¿debe abortar todo
--   -- si audit falla?": sí, sin necesitar ninguna lógica adicional.
--   -- method siempre 'manual_staff' (literal, no viene del cliente) - ver el
--   -- comentario de alcance semántico arriba del CREATE FUNCTION.
--   INSERT INTO audit_log (entity_type, entity_id, event_type, actor_user_id, detail)
--   VALUES ('quote', p_quote_id, 'quote_contracted', v_actor,
--     jsonb_build_object('method', 'manual_staff', 'folio', v_quote.folio, 'is_modern', v_is_modern));
--
--   RETURN jsonb_build_object(
--     'already_contracted', false,
--     'quote_id', p_quote_id,
--     'receipt_folio', v_receipt_folio,
--     'created_service', v_created_service
--   );
-- END;
-- $$;
