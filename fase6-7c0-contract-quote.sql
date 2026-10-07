-- =============================================================================
-- FASE 6.7C-0 — Adaptación mínima y retrocompatible de contract_quote para
--               revisiones PDF inmutables (Fase 6.7)
-- =============================================================================
--
-- ESTADO: ARCHIVO PARA REVISIÓN. No ejecutado. No validado sintácticamente
-- contra ningún motor PostgreSQL (no se ejecutó nada, por instrucción
-- expresa). Ejecutar solo después de revisarlo, por bloques, en el orden de
-- las secciones A -> B -> C.
--
-- PROBLEMA QUE RESUELVE
-- ---------------------
-- contract_quote (Fase 6.6A, fase6-6a-migracion.sql sección 4, líneas
-- 163-171 y 181 de ese archivo) hoy, para una cotización "moderna"
-- (company_snapshot IS NOT NULL):
--   1. exige p_pdf_storage_path y lo compara contra la ruta canónica fija
--      'quotes/<id>/quote.pdf' -- cualquier otra ruta lanza excepción;
--   2. escribe pdf_storage_path = p_pdf_storage_path en el UPDATE que congela.
-- Eso es incompatible con Fase 6.7, donde cada publicación vive en
--   quotes/<id>/revisions/<content_revision>.pdf
-- (ruta nueva, nunca reutilizada). Con el código actual, contratar una
-- cotización con revisión publicada (a) sería rechazado si el cliente envía
-- la ruta de revisión, o (b) si el cliente envía la canónica, reemplazaría
-- silenciosamente pdf_storage_path por la ruta legacy, desvinculando la
-- cotización de su revisión publicada.
--
-- QUÉ CAMBIA (diff conceptual mínimo, todo dentro de contract_quote)
-- -------------------------------------------------------------------
--   [1] Bloque de validación del PDF para modernas: ahora se bifurca según
--       content_revision.
--         - content_revision IS NULL (legacy-moderna, comportamiento 6.6):
--           validación original, literal, intacta (+ un guard defensivo).
--         - content_revision IS NOT NULL (publicada 6.7): la FILA es la
--           autoridad. Se valida coherencia estricta y se contrata con la
--           revisión ya publicada. Ver detalle abajo.
--   [2] Guard defensivo: una fila NO moderna (sin company_snapshot) con
--       content_revision NOT NULL es una inconsistencia -> excepción.
--   [3] El UPDATE de pdf_storage_path solo escribe p_pdf_storage_path cuando
--       la cotización es moderna Y content_revision IS NULL (camino 6.6
--       exacto). Para una revisión publicada NO se toca pdf_storage_path.
--
-- Todo lo demás es idéntico carácter por carácter al cuerpo de 6.6A: firma,
-- parámetros y defaults, SECURITY DEFINER, search_path, auth.uid(), FOR
-- UPDATE, orden de idempotencia, recibo (columnas vivas), advisory lock de
-- folio, servicio inicial, audit (mismo detail), RETURN. Ver la sección D
-- del reporte entregado en el chat y la verificación por diff.
--
-- DECISIÓN SOBRE p_pdf_storage_path PARA REVISIONES PUBLICADAS
-- ------------------------------------------------------------
-- Se evaluaron las tres alternativas:
--   (1) exigir coincidencia exacta con quotes.pdf_storage_path;
--   (2) ignorarlo y usar siempre la ruta de la fila;
--   (3) otra.
-- Se adopta una variante estricta de (1)+(2): la ruta esperada se
-- RECONSTRUYE en el servidor (quote_id real + content_revision real de la
-- fila bloqueada) y la fila debe coincidir EXACTAMENTE con ella; el
-- parámetro NUNCA decide nada. Si el navegador lo envía (no NULL), debe ser
-- idéntico a esa ruta -- si no, EXCEPCIÓN (nunca se ignora en silencio una
-- discrepancia: un cliente con una revisión obsoleta recibe un rechazo
-- claro en vez de contratar sin saberlo otra revisión). Si llega NULL, se
-- acepta: la autoridad es la fila, no el parámetro. La firma pública no
-- cambia (siguen siendo (uuid, text DEFAULT NULL)), así que los
-- consumidores actuales siguen funcionando.
--
-- LO QUE ESTA FASE NO HACE (explícito)
-- ------------------------------------
--   * No toca la creación del recibo: sigue copiando columnas VIVAS de la
--     cotización (no published_snapshot). Eso será otra subfase.
--   * No valida el contenido de published_snapshot contra las columnas
--     vivas (su estructura todavía no está definida); solo exige que exista
--     y sea un objeto JSON.
--   * No modifica cancel_quote_contract, RLS/freeze, Storage, grants,
--     ownership, trigger de valid_until, ni la migración 6.7B-1.
--   * No ejecuta ni propone pruebas funcionales automáticas: T2-T7 siguen
--     PENDIENTES / NO EJECUTADAS (ver sección de pruebas al final).
--
-- Nota de despliegue: CREATE OR REPLACE FUNCTION conserva el dueño y los
-- grants existentes de la función. Por eso esta migración NO incluye
-- GRANT/REVOKE; la sección C verifica que los permisos reales quedaron
-- exactamente como estaban.
-- =============================================================================


-- #############################################################################
-- SECCIÓN A — PRECHECKS (solo lectura). Ejecutar COMPLETA y leer cada
--             resultado ANTES de pasar a la SECCIÓN B.
-- #############################################################################

-- A.0: RESPALDO = ROLLBACK AUTORITATIVO. Copia el resultado COMPLETO de esta
-- consulta a un archivo aparte ANTES de ejecutar la SECCIÓN B. Es la
-- definición exacta de la función desplegada inmediatamente antes de
-- 6.7C-0, y por eso es el rollback AUTORITATIVO: ante cualquier rollback se
-- restaura ejecutando ESTE texto guardado. La copia comentada de 6.6A en la
-- SECCIÓN D es solo referencia/fallback; si alguna vez difiere de lo
-- guardado aquí, prevalece lo guardado de A.0.
SELECT pg_get_functiondef('public.contract_quote(uuid, text)'::regprocedure) AS definicion_actual_contract_quote;
--
-- DETENTE SI: no guardaste el resultado de esta consulta. No ejecutes la
-- SECCIÓN B sin tener ese respaldo a mano.

-- A.1: la función existe una sola vez, con la firma, seguridad y search_path
-- esperados.
SELECT p.oid::regprocedure AS firma,
       pg_get_function_arguments(p.oid) AS argumentos,
       p.prosecdef AS security_definer,
       p.proconfig AS config,
       pg_get_userbyid(p.proowner) AS dueno
FROM pg_proc p
WHERE p.proname = 'contract_quote' AND p.pronamespace = 'public'::regnamespace;
-- Esperado: EXACTAMENTE 1 fila; argumentos = 'p_quote_id uuid, p_pdf_storage_path text DEFAULT NULL::text';
--           security_definer = t; config incluye 'search_path=public, pg_temp'.
--
-- DETENTE SI: devuelve 0 filas, más de 1 fila (hay una sobrecarga vieja
-- coexistiendo), argumentos distintos, security_definer = f, o config sin
-- el search_path esperado. No aplicar B: la función desplegada no es la que
-- este archivo asume.

-- A.2: la definición desplegada es la de 6.6 y NO tiene ya los cambios de
-- 6.7C-0.
SELECT
  pg_get_functiondef(p.oid) LIKE '%/quote.pdf%'          AS tiene_ruta_canonica_6_6,
  pg_get_functiondef(p.oid) LIKE '%content_revision%'    AS ya_tiene_6_7c0,
  pg_get_functiondef(p.oid) LIKE '%/revisions/%'         AS ya_tiene_ruta_revision,
  pg_get_functiondef(p.oid) LIKE '%pg_advisory_xact_lock(hashtext(''cotizador:receipt_folio'')::bigint)%' AS tiene_advisory_lock,
  pg_get_functiondef(p.oid) LIKE '%manual_staff%'        AS tiene_audit_manual_staff
FROM pg_proc p
WHERE p.proname = 'contract_quote' AND p.pronamespace = 'public'::regnamespace;
-- Esperado: t, f, f, t, t.
--
-- DETENTE SI: cualquiera es distinto. En particular, si tiene_ruta_canonica_6_6
-- = f o tiene_advisory_lock = f, la función desplegada difiere de 6.6A
-- (alguien la editó a mano): no reemplazar sin revisar primero la
-- diferencia contra el respaldo de A.0. Si ya_tiene_6_7c0 = t, esta
-- migración ya se aplicó: no volver a ejecutarla.

-- A.3: permisos REALES actuales (deben quedar idénticos tras la migración).
SELECT p.oid::regprocedure AS firma,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_ejecuta,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_ejecuta,
       (SELECT COALESCE(bool_or(a.grantee = 0), false)
          FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a) AS public_ejecuta
FROM pg_proc p
WHERE p.proname IN ('contract_quote', 'cancel_quote_contract')
  AND p.pronamespace = 'public'::regnamespace
ORDER BY 1;
-- Esperado en ambas funciones: anon_ejecuta = f, authenticated_ejecuta = t,
-- public_ejecuta = f.
--
-- DETENTE SI: anon_ejecuta = t o public_ejecuta = t (hay una exposición
-- previa que debe corregirse por separado antes de tocar nada), o
-- authenticated_ejecuta = f.

-- A.4: las columnas de 6.7B-1 existen (esta migración depende de ellas).
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'quotes'
  AND column_name IN ('content_revision', 'published_snapshot', 'pdf_storage_path')
ORDER BY column_name;
-- Esperado: 3 filas (content_revision uuid, pdf_storage_path text,
-- published_snapshot jsonb).
-- DETENTE SI: falta alguna.

-- A.5: CLASIFICACIÓN de cada fila de quotes según sus campos de publicación
-- (content_revision, published_snapshot, pdf_storage_path). No asume un
-- número fijo de filas: distingue los estados VÁLIDOS de los inconsistentes
-- reales, usando las mismas reglas que aplicará la nueva contract_quote.
--   canónica       = 'quotes/' || id || '/quote.pdf'
--   ruta revisión  = 'quotes/' || id || '/revisions/' || content_revision || '.pdf'
WITH clasificadas AS (
  SELECT
    q.folio, q.status, q.lifecycle_status,
    -- solo las cotizaciones aún precontractuales pasan por la validación de
    -- contract_quote; el resto ya devuelve already_contracted / rechaza antes.
    (q.status = 'cotizacion' AND q.lifecycle_status = 'cotizacion') AS afecta_contract_quote,
    CASE
      -- 1. Sin publicación alguna (estado más común hoy).
      WHEN q.content_revision IS NULL AND q.published_snapshot IS NULL AND q.pdf_storage_path IS NULL
        THEN 'SIN_PUBLICACION'
      -- 2. Estado legacy/moderno de 6.6, VÁLIDO: sin revisión ni snapshot, con
      --    el PDF en la ruta canónica quote.pdf.
      WHEN q.content_revision IS NULL AND q.published_snapshot IS NULL
           AND q.pdf_storage_path = 'quotes/' || q.id::text || '/quote.pdf'
           AND q.company_snapshot IS NOT NULL AND q.status = 'cotizacion'
        THEN 'OK_LEGACY_CANONICO_6_6'
      -- 3. Revisión 6.7 publicada y COHERENTE.
      WHEN q.content_revision IS NOT NULL AND q.company_snapshot IS NOT NULL AND q.status = 'cotizacion'
           AND q.published_snapshot IS NOT NULL AND jsonb_typeof(q.published_snapshot) = 'object'
           AND q.pdf_storage_path = 'quotes/' || q.id::text || '/revisions/' || q.content_revision::text || '.pdf'
        THEN 'OK_PUBLICADA_6_7'
      -- 4. Ruta canónica en una fila NO moderna: contract_quote la ignora
      --    (legacy puro), no la rechaza; solo se reporta.
      WHEN q.content_revision IS NULL AND q.published_snapshot IS NULL
           AND q.pdf_storage_path = 'quotes/' || q.id::text || '/quote.pdf'
           AND q.company_snapshot IS NULL AND q.status = 'cotizacion'
        THEN 'INFO_PATH_CANONICO_EN_NO_MODERNA'
      -- 5. Un recibo (u otra fila que no sea cotización) con campos de publicación.
      WHEN q.status <> 'cotizacion'
        THEN 'REVISAR_FILA_NO_COTIZACION_CON_PUBLICACION'
      -- 6. Inconsistencias REALES (la nueva contract_quote las rechazará).
      WHEN q.content_revision IS NOT NULL AND q.company_snapshot IS NULL
        THEN 'INCONSISTENTE_REVISION_EN_NO_MODERNA'
      WHEN q.content_revision IS NOT NULL AND (q.pdf_storage_path IS NULL OR btrim(q.pdf_storage_path) = '')
        THEN 'INCONSISTENTE_REVISION_SIN_PATH'
      WHEN q.content_revision IS NOT NULL AND (q.published_snapshot IS NULL OR jsonb_typeof(q.published_snapshot) <> 'object')
        THEN 'INCONSISTENTE_REVISION_SIN_SNAPSHOT_VALIDO'
      WHEN q.content_revision IS NOT NULL
        THEN 'INCONSISTENTE_REVISION_PATH_NO_CORRESPONDE'
      WHEN q.pdf_storage_path IS NOT NULL AND q.pdf_storage_path <> 'quotes/' || q.id::text || '/quote.pdf'
        THEN 'INCONSISTENTE_PATH_NO_CANONICO_SIN_REVISION'
      WHEN q.published_snapshot IS NOT NULL
        THEN 'INCONSISTENTE_SNAPSHOT_SIN_REVISION'
      ELSE 'INCONSISTENTE_OTRA_COMBINACION'
    END AS categoria
  FROM quotes q
)
SELECT categoria, afecta_contract_quote, count(*) AS filas,
       string_agg(folio, ', ' ORDER BY folio) AS folios
FROM clasificadas
GROUP BY categoria, afecta_contract_quote
ORDER BY categoria, afecta_contract_quote DESC;
-- Esperado: SOLO categorías SIN_PUBLICACION, OK_LEGACY_CANONICO_6_6,
-- OK_PUBLICADA_6_7 o INFO_PATH_CANONICO_EN_NO_MODERNA. Ninguna categoría
-- INCONSISTENTE_* ni REVISAR_*. (El número de filas por categoría NO es un
-- criterio: una cotización moderna con pdf_storage_path = quote.pdf y
-- content_revision NULL es un estado legacy/6.6 válido, no un error.)
--
-- DETENTE SI:
--   * aparece cualquier categoría INCONSISTENTE_* con afecta_contract_quote = t.
--     Son filas precontractuales que la nueva contract_quote rechazaría al
--     contratarlas; revísalas (folios en la última columna) antes de aplicar
--     B. Corregir esos datos es una decisión aparte, no parte de esta fase.
-- REVISAR (no bloquea B, pero anótalo y repórtalo):
--   * INCONSISTENTE_* con afecta_contract_quote = f: la fila ya está
--     contratada/cancelada, contract_quote ni siquiera llega a validarla,
--     pero es una anomalía de datos.
--   * REVISAR_FILA_NO_COTIZACION_CON_PUBLICACION: un recibo no debería tener
--     content_revision, published_snapshot ni pdf_storage_path.
-- NO bloquean: SIN_PUBLICACION, OK_LEGACY_CANONICO_6_6, OK_PUBLICADA_6_7,
-- INFO_PATH_CANONICO_EN_NO_MODERNA (esta última: contract_quote legacy
-- ignora el parámetro y no toca el path).

-- A.6: HUELLAS para comparar después (guárdalas).
SELECT
  (SELECT md5(pg_get_functiondef('public.cancel_quote_contract(uuid, text)'::regprocedure))) AS md5_cancel_quote_contract,
  (SELECT count(*) FROM quotes)  AS total_quotes,
  (SELECT count(*) FROM services) AS total_services,
  (SELECT count(*) FROM audit_log) AS total_audit_log,
  (SELECT md5(string_agg(id::text || ':' || lifecycle_status::text || ':' || COALESCE(pdf_storage_path, '-') || ':' || COALESCE(content_revision::text, '-'),
                         ',' ORDER BY id))
     FROM quotes WHERE status = 'cotizacion') AS huella_cotizaciones;
-- Anota los 5 valores. La SECCIÓN C debe devolverlos IDÉNTICOS.
-- (Si lifecycle_status es NULL en alguna fila el md5 sigue siendo válido
-- porque string_agg ignora el NULL completo de esa fila; solo importa que
-- antes y después coincidan.)


-- #############################################################################
-- SECCIÓN B — REEMPLAZO DE contract_quote (una sola sentencia, atómica).
--             Ejecutar SOLO si toda la SECCIÓN A pasó sin DETENTE SI.
-- #############################################################################
-- Cuerpo = 6.6A literal, salvo los 3 puntos marcados con "-- [6.7C-0]".

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
    -- ---- Moderna SIN revisión (comportamiento 6.6, intacto) ----
    v_expected_path := 'quotes/' || p_quote_id::text || '/quote.pdf';
    IF p_pdf_storage_path IS NULL OR btrim(p_pdf_storage_path) = '' THEN
      RAISE EXCEPTION 'Cotización moderna: se requiere p_pdf_storage_path (el PDF debe subirse a Storage antes de llamar a esta función — ver ensureQuotePdfPersisted de Fase 6.5)';
    END IF;
    IF p_pdf_storage_path <> v_expected_path THEN
      RAISE EXCEPTION 'p_pdf_storage_path inválido: se esperaba % y se recibió %', v_expected_path, p_pdf_storage_path;
    END IF;
    -- [6.7C-0] Guard defensivo: sin revisión, un pdf_storage_path ya
    -- existente solo puede ser la ruta canónica; cualquier otra (p. ej. una
    -- ruta de revisión con content_revision en NULL) sería sobrescrita por la
    -- canónica en el UPDATE de abajo — se rechaza en vez de reemplazarla.
    IF v_quote.pdf_storage_path IS NOT NULL AND v_quote.pdf_storage_path <> v_expected_path THEN
      RAISE EXCEPTION 'Inconsistencia: la cotización % tiene pdf_storage_path (%) distinto de la ruta canónica pero no tiene content_revision', v_quote.folio, v_quote.pdf_storage_path;
    END IF;
  END IF;
  -- Legacy: p_pdf_storage_path se ignora aunque venga informado — nunca se
  -- persiste una ruta para una cotización sin snapshot moderno. Postgres NO
  -- verifica que Storage realmente contenga esos bytes — esa garantía es
  -- responsabilidad exclusiva del caller (que ya ejecutó
  -- ensureQuotePdfPersisted con éxito antes de invocar esta función).

  -- [6.7C-0] (punto 3) Solo el camino 6.6 (moderna sin revisión) escribe
  -- p_pdf_storage_path. Con revisión publicada, pdf_storage_path NO se toca.
  UPDATE quotes SET
    contracted = true,
    lifecycle_status = 'contratado',
    pdf_storage_path = CASE WHEN v_is_modern AND v_quote.content_revision IS NULL THEN p_pdf_storage_path ELSE pdf_storage_path END
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
--             después de la SECCIÓN B y comparar contra la SECCIÓN A.
-- #############################################################################

-- C.1: sigue habiendo UNA sola contract_quote, misma firma/seguridad/config/dueño
-- (comparar con A.1: deben ser idénticos).
SELECT p.oid::regprocedure AS firma,
       pg_get_function_arguments(p.oid) AS argumentos,
       p.prosecdef AS security_definer,
       p.proconfig AS config,
       pg_get_userbyid(p.proowner) AS dueno
FROM pg_proc p
WHERE p.proname = 'contract_quote' AND p.pronamespace = 'public'::regnamespace;
-- DETENTE SI: difiere de A.1 en cualquier columna.

-- C.2: permisos IDÉNTICOS a A.3 (CREATE OR REPLACE los conserva).
SELECT p.oid::regprocedure AS firma,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_ejecuta,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_ejecuta,
       (SELECT COALESCE(bool_or(a.grantee = 0), false)
          FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a) AS public_ejecuta
FROM pg_proc p
WHERE p.proname IN ('contract_quote', 'cancel_quote_contract')
  AND p.pronamespace = 'public'::regnamespace
ORDER BY 1;
-- Esperado: igual que A.3 (anon f, authenticated t, public f).
-- DETENTE SI: cualquier valor cambió respecto a A.3 -> ROLLBACK (sección D).

-- C.3: la nueva definición contiene ambos caminos.
SELECT
  pg_get_functiondef(p.oid) LIKE '%/quote.pdf%'                     AS conserva_ruta_canonica,
  pg_get_functiondef(p.oid) LIKE '%/revisions/%'                    AS tiene_ruta_revision,
  pg_get_functiondef(p.oid) LIKE '%v_quote.content_revision IS NULL THEN p_pdf_storage_path%' AS update_condicionado,
  pg_get_functiondef(p.oid) LIKE '%pg_advisory_xact_lock(hashtext(''cotizador:receipt_folio'')::bigint)%' AS conserva_advisory_lock,
  pg_get_functiondef(p.oid) LIKE '%manual_staff%'                   AS conserva_audit
FROM pg_proc p
WHERE p.proname = 'contract_quote' AND p.pronamespace = 'public'::regnamespace;
-- Esperado: t, t, t, t, t.
-- DETENTE SI: cualquiera es f -> ROLLBACK.

-- C.4: HUELLAS idénticas a A.6 (la migración no escribe datos ni toca
-- cancel_quote_contract).
SELECT
  (SELECT md5(pg_get_functiondef('public.cancel_quote_contract(uuid, text)'::regprocedure))) AS md5_cancel_quote_contract,
  (SELECT count(*) FROM quotes)  AS total_quotes,
  (SELECT count(*) FROM services) AS total_services,
  (SELECT count(*) FROM audit_log) AS total_audit_log,
  (SELECT md5(string_agg(id::text || ':' || lifecycle_status::text || ':' || COALESCE(pdf_storage_path, '-') || ':' || COALESCE(content_revision::text, '-'),
                         ',' ORDER BY id))
     FROM quotes WHERE status = 'cotizacion') AS huella_cotizaciones;
-- DETENTE SI: cualquiera de los 5 valores difiere de A.6.

-- C.5: el freeze de 6.6 sigue activo (políticas RESTRICTIVE intactas).
SELECT policyname, permissive, cmd
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'quotes'
  AND policyname IN ('quotes_update_lock', 'quotes_delete_lock')
ORDER BY policyname;
-- Esperado: 2 filas, permissive = RESTRICTIVE, cmd = UPDATE / DELETE.


-- =============================================================================
-- PRUEBAS FUNCIONALES — PENDIENTES / NO EJECUTADAS
-- =============================================================================
-- Por decisión del proyecto no hay entorno QA y T2-T7 siguen pendientes;
-- esta fase NO las declara PASS. Casos que cubrirá la verificación funcional
-- cuando se autorice (con una sesión authenticated real, nunca service_role):
--   L1  legacy-moderna (content_revision NULL) + p = quotes/<id>/quote.pdf
--       -> contrata, escribe esa ruta (comportamiento 6.6).
--   L2  legacy-moderna + p distinto o NULL -> excepción (6.6).
--   L3  legacy puro (sin company_snapshot, sin revisión) -> contrata, ignora p.
--   R1  revisión publicada coherente + p NULL            -> contrata, path intacto.
--   R2  revisión publicada coherente + p = ruta publicada -> contrata, path intacto.
--   R3  revisión publicada + p = quote.pdf / otra revisión / otro quote_id
--       -> excepción, nada cambia.
--   R4  content_revision NOT NULL con pdf_storage_path NULL -> excepción.
--   R5  content_revision NOT NULL con published_snapshot NULL -> excepción.
--   R6  pdf_storage_path no corresponde a quote_id + content_revision -> excepción.
--   R7  fila no moderna con content_revision -> excepción.
--   R8  moderna sin revisión con pdf_storage_path no canónico -> excepción.
--   I1  segunda llamada sobre una ya contratada -> already_contracted, sin
--       exigir p (idempotencia antes de validar, igual que 6.6).
--   I2  recibo, servicio, audit y RETURN idénticos a 6.6 en todos los casos.


-- #############################################################################
-- SECCIÓN D — ROLLBACK MANUAL (NO ejecutar junto con la migración).
-- #############################################################################
-- ROLLBACK AUTORITATIVO: el resultado de A.0 (pg_get_functiondef de
-- public.contract_quote(uuid, text)) guardado ANTES de ejecutar la SECCIÓN B.
-- Representa exactamente la función que estaba desplegada inmediatamente
-- antes de 6.7C-0; para revertir, ejecuta ese texto guardado (es un
-- CREATE OR REPLACE FUNCTION completo).
--
-- La copia comentada de abajo (líneas 101-271 de fase6-6a-migracion.sql) es
-- SOLO referencia/fallback histórico de 6.6A. Si A.0 difiere de esta copia,
-- PREVALECE A.0. CREATE OR REPLACE conserva dueño y grants, así que en
-- ningún caso hace falta tocar permisos.
--
-- Después del rollback ejecutar C.1-C.4 de nuevo: C.3 debe dar
-- tiene_ruta_revision = f y ya_tiene_6_7c0 (A.2) = f.
-- Importante: tras un rollback, una cotización con revisión publicada ya
-- NO podrá contratarse (vuelve el rechazo de 6.6 a rutas no canónicas).
--
-- CREATE OR REPLACE FUNCTION contract_quote(
--   p_quote_id uuid,
--   p_pdf_storage_path text DEFAULT NULL
-- ) RETURNS jsonb
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public, pg_temp
-- AS $
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
--   IF v_is_modern THEN
--     v_expected_path := 'quotes/' || p_quote_id::text || '/quote.pdf';
--     IF p_pdf_storage_path IS NULL OR btrim(p_pdf_storage_path) = '' THEN
--       RAISE EXCEPTION 'Cotización moderna: se requiere p_pdf_storage_path (el PDF debe subirse a Storage antes de llamar a esta función — ver ensureQuotePdfPersisted de Fase 6.5)';
--     END IF;
--     IF p_pdf_storage_path <> v_expected_path THEN
--       RAISE EXCEPTION 'p_pdf_storage_path inválido: se esperaba % y se recibió %', v_expected_path, p_pdf_storage_path;
--     END IF;
--   END IF;
--   -- Legacy: p_pdf_storage_path se ignora aunque venga informado — nunca se
--   -- persiste una ruta para una cotización sin snapshot moderno. Postgres NO
--   -- verifica que Storage realmente contenga esos bytes — esa garantía es
--   -- responsabilidad exclusiva del caller (que ya ejecutó
--   -- ensureQuotePdfPersisted con éxito antes de invocar esta función).
--
--   UPDATE quotes SET
--     contracted = true,
--     lifecycle_status = 'contratado',
--     pdf_storage_path = CASE WHEN v_is_modern THEN p_pdf_storage_path ELSE pdf_storage_path END
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
--     v_next_n := COALESCE((regexp_match(v_last_folio, '-(\d+)
))[1]::int, 0) + 1;
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
-- $;
