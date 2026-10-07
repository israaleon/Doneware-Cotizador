-- =============================================================================
-- FASE 6.7B-1 — Preparación de esquema: valid_until, content_revision,
--               published_snapshot, UNIQUE(quote_id) en quote_acceptance_events
-- =============================================================================
--
-- ALCANCE EXCLUSIVO: esta migración SOLO agrega columnas nuevas, un trigger
-- de mantenimiento para valid_until, y un índice único de defensa en
-- profundidad. NO modifica contract_quote, cancel_quote_contract, políticas
-- de freeze (Fase 6.6), Storage, ni ninguna función/política existente.
--
-- ESTRUCTURA (ejecutar en este orden, cada SECCIÓN por separado, deteniéndose
-- a revisar el resultado antes de pasar a la siguiente):
--   SECCIÓN A — Verificaciones previas (solo lectura, con criterios DETENTE SI)
--   SECCIÓN B — Migración (ALTER/CREATE, idempotente)
--   SECCIÓN C — Verificaciones posteriores (solo lectura)
--   SECCIÓN D — Pruebas funcionales T2-T6 (SQL, con fixtures QA autolimpiables)
--               T1 (verificación del backfill) NO es un fixture QA -- se
--               comprueba directamente sobre las filas reales existentes,
--               como un checkpoint de solo lectura DENTRO de la SECCIÓN B,
--               entre B.2 y B.3 (ver ahí). No se deshabilita ningún
--               trigger en producción para probarlo.
--               T7 (contract_quote/cancel_quote_contract con sesión
--               authenticated real) está en el script separado
--               fase6-7b1-test-t7-rpc.mjs, y debe correrse contra un
--               proyecto Supabase de QA aislado (mismo esquema, cuenta
--               authenticated de QA) -- nunca contra producción ni con
--               credenciales de staff reales. No puede ejecutarse en el
--               editor SQL porque necesita una sesión de PostgREST real,
--               no la conexión privilegiada del editor.
--
-- AJUSTE DE METODOLOGÍA DE PRUEBAS (esta ronda, sin tocar la arquitectura
-- de la migración): la versión anterior de T1 deshabilitaba el trigger
-- (`ALTER TABLE quotes DISABLE TRIGGER ...`) sobre una fila QA para forzar
-- un valid_until NULL y probar el backfill. Deshabilitar un trigger, aunque
-- sea momentáneamente y solo para una fila QA, es una operación que afecta
-- a la tabla completa mientras dura (cualquier INSERT/UPDATE concurrente
-- de otro proceso durante esa ventana también correría sin el trigger) --
-- no es aceptable como técnica de prueba en una base de producción. T1 se
-- reemplaza por un checkpoint de solo lectura sobre las filas reales,
-- ejecutado en el momento exacto en que el backfill realmente opera
-- (después de crear el trigger, antes de correr la UPDATE del backfill) --
-- sin deshabilitar nada, sin fixtures, sin tocar ningún dato.
--
-- CORRECCIÓN respecto a la versión anterior (revisada por el usuario, no
-- ejecutada): el trigger original solo recalculaba valid_until cuando
-- created_at o valid_days cambiaban. El backfill (`UPDATE quotes SET
-- valid_days = valid_days`) no cambia valid_days, así que el trigger caía
-- en la rama "conservar OLD.valid_until" -- que era NULL antes del backfill
-- -- y el backfill no hacía nada. Corregido en la SECCIÓN B: el trigger
-- ahora también recalcula cuando OLD.valid_until IS NULL. Esto no abre
-- ninguna vía para fijar valid_until directamente: la condición extra solo
-- decide CUÁNDO recalcular a partir de created_at/valid_days, nunca usa un
-- valor de valid_until enviado por el cliente -- ese siempre se descarta.
--
-- HALLAZGO SOBRE VOLATILIDAD DE timezone() (ver reporte adjunto en el chat,
-- verificado empíricamente con consulta y resultado reales, no solo
-- documentación): el overload timezone(text, timestamp with time zone) --
-- exactamente el que usa esta migración -- resultó ser IMMUTABLE, no STABLE
-- como yo había asumido sin verificar en 6.7A-3/6.7A-4. Esto significa que
-- el diseño original con GENERATED ALWAYS AS (...) STORED probablemente sí
-- sería aceptado por PostgreSQL. NO cambio el diseño aquí -- el usuario
-- pidió explícitamente no introducir cambios arquitectónicos en esta
-- ronda, y el trigger ya aprobado sigue siendo correcto y funcional. Se
-- deja documentado para una decisión futura, separada, si se quiere
-- simplificar.
--
-- HALLAZGOS REALES DE ESQUEMA (inspección empírica previa, vía PostgREST
-- OpenAPI + lecturas/pruebas con service_role, 2026-09-29):
--
--   * quotes.content_revision   -> NO EXISTE (error 42703 confirmado).
--   * quotes.valid_until        -> NO EXISTE (error 42703 confirmado).
--   * quotes.published_snapshot -> NO EXISTE (error 42703 confirmado).
--   * quotes.pdf_storage_path   -> existe (text, nullable), NULL en las
--     5 filas reales actuales.
--   * quotes.accepted_at / accepted_method / cancelled_at / cancelled_reason
--     -> YA EXISTEN (de una fase anterior). No se tocan aquí.
--   * Existe un CHECK real: quotes_status_lifecycle_check (descubierto al
--     intentar insertar lifecycle_status='ESTADO_INVALIDO_QA' -> 23514).
--     Esta migración no lo modifica ni depende de su definición exacta.
--   * quotes.valid_days: nullable a nivel de columna (solo DEFAULT 15 en
--     INSERT). Dato real: 0 filas con valid_days NULL, 0 con created_at
--     NULL, sobre 5 filas totales.
--   * Datos reales actuales (5 quotes): 2 legado contratadas (COT-2026-0001,
--     COT-2026-0002) con sus recibos (REC-2026-0001, REC-2026-0002), y
--     1 moderna precontractual (COT-2026-0003, company_snapshot NOT NULL).
--   * quote_acceptance_events: 0 filas reales, sin UNIQUE(quote_id) --
--     confirmado insertando y limpiando dos eventos de prueba para el
--     mismo quote_id (201/201, sin error).
--
-- Ninguna prueba de inspección anterior a esta migración dejó datos
-- permanentes: todos los fixtures QA67B1-* fueron creados y eliminados,
-- y el conteo de quotes reales volvió siempre a 5/5.
--
-- =============================================================================


-- #############################################################################
-- SECCIÓN A — VERIFICACIONES PREVIAS (solo lectura, ejecutar y leer ANTES de
--             pasar a la SECCIÓN B)
-- #############################################################################

-- A.1: las columnas nuevas NO deben existir todavía.
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'quotes'
  AND column_name IN ('content_revision', 'published_snapshot', 'valid_until');
--
-- DETENTE SI: esta consulta devuelve alguna fila. Significaría que una
-- corrida parcial anterior ya creó alguna de estas columnas con una
-- definición que no controlamos. Investiga esa columna manualmente antes
-- de continuar -- el IF NOT EXISTS de la SECCIÓN B no valida que una
-- columna preexistente tenga el tipo o el trigger correctos.

-- A.2: inventario de índices actuales sobre quote_acceptance_events.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'quote_acceptance_events';
--
-- DETENTE SI: ya aparece un índice llamado
-- "quote_acceptance_events_quote_id_key" cuya definición NO diga "UNIQUE"
-- o no sea exactamente sobre (quote_id). El CREATE UNIQUE INDEX IF NOT
-- EXISTS de la SECCIÓN B lo omitiría silenciosamente si ya existe con ese
-- nombre, sin avisar que la definición real es distinta a la esperada.

-- A.3: no debe haber ya quote_id duplicados en quote_acceptance_events.
SELECT quote_id, count(*)
FROM quote_acceptance_events
GROUP BY quote_id
HAVING count(*) > 1;
--
-- DETENTE SI: esta consulta devuelve alguna fila. La creación del índice
-- único fallaría (o dejaría datos inconsistentes sin resolver). Vuelve a
-- correrla justo antes de ejecutar la SECCIÓN B, no confíes en el hallazgo
-- de hace unos días.

-- A.4 (opcional, informativo, de solo lectura, cero riesgo): confirmar en
-- ESTA instancia real de Supabase la volatilidad exacta del overload de
-- timezone() que usa el trigger. Yo lo verifiqué contra un motor
-- PostgreSQL 18.3 real (WASM, aislado, no esta base) y el resultado fue
-- IMMUTABLE para timezone(text, timestamp with time zone) -- ver el
-- reporte en el chat para la consulta y el resultado completos. Esta
-- consulta te deja confirmarlo también contra la versión real de Postgres
-- de tu proyecto Supabase, sin ningún riesgo (no modifica nada):
SELECT p.proname, pg_get_function_arguments(p.oid) AS args, p.provolatile,
       CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' WHEN 'v' THEN 'VOLATILE' END AS volatility
FROM pg_proc p
WHERE p.proname = 'timezone' AND pg_get_function_arguments(p.oid) ILIKE '%text, timestamp with time zone%';
-- No es un DETENTE SI -- es solo para tu propia confirmación directa.


-- #############################################################################
-- SECCIÓN B — MIGRACIÓN (idempotente)
-- #############################################################################

-- B.1: columnas nuevas en quotes.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS content_revision uuid;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS published_snapshot jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS valid_until date;

COMMENT ON COLUMN quotes.content_revision IS
  'Identificador de la revisión actualmente publicada (Fase 6.7). NULL en filas históricas anteriores a esta fase; el núcleo de contratación/aceptación debe tratar NULL como "sin snapshot publicado, usar columnas en vivo".';
COMMENT ON COLUMN quotes.published_snapshot IS
  'Copia congelada del contenido contractual (items, totales, impuestos, etc.) correspondiente exactamente a content_revision/pdf_storage_path publicados. NULL en filas históricas.';
COMMENT ON COLUMN quotes.valid_until IS
  'Fecha de vencimiento calculada por el trigger set_quote_valid_until a partir de created_at (America/Mexico_City) + valid_days. No debe escribirse manualmente: el trigger sobrescribe cualquier valor entrante.';

-- B.2: trigger de mantenimiento de valid_until (CORREGIDO).
--
-- Por qué trigger (decisión ya aprobada, no se cambia en esta ronda a
-- pesar del hallazgo de A.4 -- ver nota al inicio del archivo): un
-- trigger no depende de que la expresión sea IMMUTABLE, así que el
-- resultado de A.4 no lo invalida ni lo hace necesario cambiarlo ahora.
--
-- Condición de recálculo (corregida): se recalcula si es INSERT, si
-- created_at cambió, si valid_days cambió, O SI OLD.valid_until ES NULL.
-- Esta última condición es la que faltaba: sin ella, una fila con
-- valid_until todavía NULL (recién migrada) nunca se recalcula si el
-- UPDATE no toca created_at/valid_days -- exactamente el caso del
-- backfill de B.3. Agregar esta condición NO abre ninguna vía para fijar
-- valid_until directamente: decide únicamente CUÁNDO recalcular a partir
-- de created_at/valid_days; el valor de valid_until que el cliente haya
-- podido enviar en el UPDATE nunca se lee ni se usa en ninguna rama.
--
-- En cualquier otro caso: se preserva OLD.valid_until sin recalcular --
-- evita recomputar en cada UPDATE que no toca esos campos.
--
-- Tolerancia a NULL: si created_at o valid_days son NULL, valid_until
-- queda en NULL (no lanza excepción).

CREATE OR REPLACE FUNCTION set_quote_valid_until()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.created_at  IS DISTINCT FROM OLD.created_at
     OR NEW.valid_days  IS DISTINCT FROM OLD.valid_days
     OR OLD.valid_until IS NULL THEN
    IF NEW.created_at IS NULL OR NEW.valid_days IS NULL THEN
      NEW.valid_until := NULL;
    ELSE
      NEW.valid_until := (timezone('America/Mexico_City', NEW.created_at))::date + NEW.valid_days;
    END IF;
  ELSE
    NEW.valid_until := OLD.valid_until;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_quote_valid_until ON quotes;

CREATE TRIGGER trg_set_quote_valid_until
  BEFORE INSERT OR UPDATE ON quotes
  FOR EACH ROW
  EXECUTE FUNCTION set_quote_valid_until();

-- B.2.1 — CHECKPOINT T1 (solo lectura, sobre datos reales, sin fixtures ni
-- triggers deshabilitados): en este punto ya existen las columnas nuevas y
-- el trigger, pero el backfill de B.3 todavía NO ha corrido. Las filas
-- reales preexistentes deben mostrar valid_until en NULL (ADD COLUMN no
-- ejecuta el trigger sobre filas ya existentes -- solo INSERT/UPDATE lo
-- disparan). Ejecuta esta consulta y ANOTA el resultado antes de correr B.3:
SELECT folio, created_at, valid_days, valid_until
FROM quotes
ORDER BY created_at;
-- Esperado AQUÍ (antes de B.3): valid_until NULL en TODAS las filas reales
-- existentes (las columnas se acaban de agregar, nadie las ha tocado con
-- un INSERT/UPDATE todavía).
--
-- DETENTE SI: alguna fila ya muestra valid_until NO NULL en este punto --
-- significaría que algo más (otro proceso, otra sesión) escribió en
-- `quotes` entre B.1/B.2 y este checkpoint, disparando el trigger antes de
-- tiempo. Investiga antes de continuar con B.3.

-- B.3: backfill de valid_until para las filas reales existentes.
-- No duplica la fórmula: es una UPDATE real, el trigger de B.2 calcula.
-- Corre con el rol privilegiado del editor SQL (bypassa RLS), igual que
-- el backfill de fase6-6a-migracion.sql -- no depende de ni modifica las
-- políticas RESTRICTIVE del freeze de Fase 6.6.
UPDATE quotes SET valid_days = valid_days;

-- B.3.1 — CHECKPOINT T1 (continuación, solo lectura): confirma que el
-- backfill sí funcionó sobre las MISMAS filas reales que en B.2.1 -- esta
-- es la comprobación que en la versión con `valid_days = valid_days` sin
-- la corrección de B.2 habría fallado silenciosamente (valid_until se
-- habría quedado en NULL). Compara manualmente contra el resultado de
-- B.2.1: deben ser los mismos folios, ahora con valid_until poblado.
SELECT folio, created_at, valid_days, valid_until,
       (timezone('America/Mexico_City', created_at))::date + valid_days AS esperado
FROM quotes
ORDER BY created_at;
-- Esperado AQUÍ (después de B.3): valid_until = esperado en TODAS las filas,
-- ya NO NULL. Si alguna fila sigue en NULL y tiene created_at/valid_days no
-- nulos, el backfill no funcionó -- detente y no continúes a la SECCIÓN C.

-- B.4: UNIQUE(quote_id) en quote_acceptance_events.
-- Índice único (no ADD CONSTRAINT) porque CREATE UNIQUE INDEX IF NOT
-- EXISTS es totalmente idempotente. Confirmado seguro por A.3.
CREATE UNIQUE INDEX IF NOT EXISTS quote_acceptance_events_quote_id_key
  ON quote_acceptance_events (quote_id);


-- #############################################################################
-- SECCIÓN C — VERIFICACIONES POSTERIORES (solo lectura, ejecutar y revisar
--             cada resultado antes de pasar a la SECCIÓN D)
-- #############################################################################

-- C.1: las 3 columnas nuevas existen con el tipo esperado.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'quotes'
  AND column_name IN ('content_revision', 'published_snapshot', 'valid_until')
ORDER BY column_name;
-- Esperado: content_revision uuid/YES, published_snapshot jsonb/YES, valid_until date/YES

-- C.2: el trigger existe y está activo.
SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'quotes'::regclass AND tgname = 'trg_set_quote_valid_until';
-- Esperado: 1 fila, tgenabled = 'O' (habilitado)

-- C.3: valid_until quedó poblado para las filas reales existentes, y
-- coincide con la fórmula manual.
SELECT folio, created_at, valid_days, valid_until,
       (timezone('America/Mexico_City', created_at))::date + valid_days AS esperado
FROM quotes
ORDER BY created_at;
-- Esperado: valid_until = esperado en todas las filas, sin NULL inesperados
-- (esta es la comprobación que en la versión anterior habría fallado --
-- confirma directamente que la corrección de B.2 funcionó).

-- C.4: content_revision y published_snapshot siguen NULL (esta fase no
-- escribe nada desde la app).
SELECT folio, content_revision, published_snapshot
FROM quotes
ORDER BY created_at;
-- Esperado: NULL en ambas columnas, en todas las filas.

-- C.5: el índice es realmente UNIQUE y cubre exactamente (quote_id).
SELECT
  ic.relname AS index_name,
  ix.indisunique AS is_unique,
  array_agg(a.attname ORDER BY k.ord) AS indexed_columns
FROM pg_index ix
JOIN pg_class ic ON ic.oid = ix.indexrelid
JOIN pg_class tc ON tc.oid = ix.indrelid
JOIN unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attnum = k.attnum
WHERE ic.relname = 'quote_acceptance_events_quote_id_key'
GROUP BY ic.relname, ix.indisunique;
-- Esperado: is_unique = true, indexed_columns = {quote_id} (una sola columna).

-- C.6: confirmar que los datos reales siguen intactos.
SELECT count(*) AS total_quotes FROM quotes;
SELECT count(*) AS total_events FROM quote_acceptance_events;
-- Esperado: total_quotes = 5, total_events = 0 (o los valores reales que
-- existan legítimamente para entonces -- compara contra el conteo que
-- tenías ANTES de correr la SECCIÓN B).


-- #############################################################################
-- SECCIÓN D — PRUEBAS FUNCIONALES (fixtures QA autolimpiables)
-- #############################################################################
--
-- D.1-D.6 (T1-T6) son SQL puro, ejecútalas aquí mismo en el editor.
-- T7 (contract_quote/cancel_quote_contract con sesión authenticated real)
-- está en fase6-7b1-test-t7-rpc.mjs -- NO puede ejecutarse en el editor
-- SQL porque contract_quote debe invocarse vía PostgREST con un token de
-- un usuario autenticado real, no con la conexión privilegiada del editor
-- (que bypassa RLS y no demuestra nada sobre permisos de `authenticated`).
--
-- Ejecuta cada bloque por separado y compara el resultado real contra el
-- comentario "Esperado" antes de seguir con el siguiente.

-- ---------------------------------------------------------------------------
-- T1: ya NO es un fixture QA -- se verificó como checkpoint de solo
-- lectura sobre datos reales en B.2.1 / B.3.1, dentro de la SECCIÓN B,
-- sin deshabilitar ningún trigger. Si ya revisaste esos dos checkpoints y
-- valid_until quedó poblado correctamente, T1 está cubierto.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- T2: UPDATE que cambia valid_days -> debe recalcular.
-- ---------------------------------------------------------------------------
INSERT INTO quotes (folio, status, lifecycle_status, client_name, items,
  discount_type, discount_value, subtotal, discount, iva, iva_rate, apply_iva,
  total, valid_days)
VALUES ('QA67B1-T2-0001', 'cotizacion', 'cotizacion', 'QA67B1_t2', '[{"name":"x","price":1,"qty":1}]'::jsonb,
  'percent', 0, 1, 0, 0, 0, false, 1, 15);
UPDATE quotes SET valid_days = 30 WHERE folio = 'QA67B1-T2-0001';
SELECT folio, valid_days, valid_until,
       (timezone('America/Mexico_City', created_at))::date + 30 AS esperado
FROM quotes WHERE folio = 'QA67B1-T2-0001';
-- Esperado: valid_until = esperado (created_at + 30), distinto del valor con 15.
DELETE FROM quotes WHERE folio = 'QA67B1-T2-0001';

-- ---------------------------------------------------------------------------
-- T3: UPDATE de un campo no relacionado -> valid_until NO debe recalcularse.
-- ---------------------------------------------------------------------------
INSERT INTO quotes (folio, status, lifecycle_status, client_name, items,
  discount_type, discount_value, subtotal, discount, iva, iva_rate, apply_iva,
  total, valid_days, notes)
VALUES ('QA67B1-T3-0001', 'cotizacion', 'cotizacion', 'QA67B1_t3', '[{"name":"x","price":1,"qty":1}]'::jsonb,
  'percent', 0, 1, 0, 0, 0, false, 1, 15, 'original');
SELECT valid_until AS antes FROM quotes WHERE folio = 'QA67B1-T3-0001';
UPDATE quotes SET notes = 'editado' WHERE folio = 'QA67B1-T3-0001';
SELECT valid_until AS despues FROM quotes WHERE folio = 'QA67B1-T3-0001';
-- Esperado: "antes" y "despues" son EXACTAMENTE el mismo valor.
DELETE FROM quotes WHERE folio = 'QA67B1-T3-0001';

-- ---------------------------------------------------------------------------
-- T4: intento de modificación directa -> debe ser ignorado.
-- ---------------------------------------------------------------------------
INSERT INTO quotes (folio, status, lifecycle_status, client_name, items,
  discount_type, discount_value, subtotal, discount, iva, iva_rate, apply_iva,
  total, valid_days)
VALUES ('QA67B1-T4-0001', 'cotizacion', 'cotizacion', 'QA67B1_t4', '[{"name":"x","price":1,"qty":1}]'::jsonb,
  'percent', 0, 1, 0, 0, 0, false, 1, 15);
UPDATE quotes SET valid_until = '2099-01-01' WHERE folio = 'QA67B1-T4-0001';
SELECT valid_until FROM quotes WHERE folio = 'QA67B1-T4-0001';
-- Esperado: NUNCA 2099-01-01 -- el valor calculado real (created_at + 15).
DELETE FROM quotes WHERE folio = 'QA67B1-T4-0001';

-- ---------------------------------------------------------------------------
-- T5: valores NULL -> valid_until NULL, sin error.
-- ---------------------------------------------------------------------------
INSERT INTO quotes (folio, status, lifecycle_status, client_name, items,
  discount_type, discount_value, subtotal, discount, iva, iva_rate, apply_iva,
  total, valid_days)
VALUES ('QA67B1-T5-0001', 'cotizacion', 'cotizacion', 'QA67B1_t5', '[{"name":"x","price":1,"qty":1}]'::jsonb,
  'percent', 0, 1, 0, 0, 0, false, 1, NULL);
SELECT folio, valid_days, valid_until FROM quotes WHERE folio = 'QA67B1-T5-0001';
-- Esperado: valid_until NULL, sin excepción lanzada por el INSERT.
DELETE FROM quotes WHERE folio = 'QA67B1-T5-0001';

-- ---------------------------------------------------------------------------
-- T6: UNIQUE(quote_id) en quote_acceptance_events -- segundo evento debe fallar.
-- ---------------------------------------------------------------------------
INSERT INTO quotes (folio, status, lifecycle_status, client_name, items,
  discount_type, discount_value, subtotal, discount, iva, iva_rate, apply_iva, total)
VALUES ('QA67B1-T6-0001', 'cotizacion', 'cotizacion', 'QA67B1_t6', '[{"name":"x","price":1,"qty":1}]'::jsonb,
  'percent', 0, 1, 0, 0, 0, false, 1)
RETURNING id;
-- Copia el id devuelto y sustitúyelo en las dos líneas siguientes:
-- INSERT INTO quote_acceptance_events (quote_id, folio, client_name) VALUES ('<id>', 'QA67B1-T6-0001', 'x');
-- INSERT INTO quote_acceptance_events (quote_id, folio, client_name) VALUES ('<id>', 'QA67B1-T6-0001', 'x');
-- Esperado: el primer INSERT funciona, el segundo falla con 23505.
-- DELETE FROM quote_acceptance_events WHERE folio = 'QA67B1-T6-0001';
DELETE FROM quotes WHERE folio = 'QA67B1-T6-0001';

-- ---------------------------------------------------------------------------
-- T7: ejecutar por separado -- ver fase6-7b1-test-t7-rpc.mjs
-- (contract_quote / cancel_quote_contract con sesión authenticated real)
-- ---------------------------------------------------------------------------


-- =============================================================================
-- ROLLBACK MANUAL (ejecutar solo si es necesario revertir esta migración)
-- =============================================================================

-- DROP INDEX IF EXISTS quote_acceptance_events_quote_id_key;
-- DROP TRIGGER IF EXISTS trg_set_quote_valid_until ON quotes;
-- DROP FUNCTION IF EXISTS set_quote_valid_until();
-- ALTER TABLE quotes DROP COLUMN IF EXISTS valid_until;
-- ALTER TABLE quotes DROP COLUMN IF EXISTS published_snapshot;
-- ALTER TABLE quotes DROP COLUMN IF EXISTS content_revision;
