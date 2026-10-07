-- ============================================================================
-- FASE 6.3A — Términos y datos de pago por tipo (terms_by_type / bank_info_by_type)
-- SOLO agrega 2 columnas jsonb + 2 CHECK constraints a app_config.
-- NO toca terms/bank_info existentes. NO toca ninguna fila de `quotes`.
-- NO toca RLS (las columnas nuevas heredan la policy de fila ya existente).
-- Idempotente: seguro de ejecutar más de una vez.
-- ============================================================================

-- ---------- 1. Columnas nuevas ----------
-- Default '{}'::jsonb (no {"instalacion":null,...}) — una clave ausente
-- significa "sin override específico". NOT NULL: nunca se permite NULL.
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS terms_by_type jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS bank_info_by_type jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ---------- 2. Constraints: deben ser objetos JSON, sin restringir claves ----------
-- (Postgres no soporta "ADD CONSTRAINT IF NOT EXISTS" — se verifica manualmente
-- contra pg_constraint, ligado específicamente a app_config vía conrelid, para
-- que el script sea seguro de re-ejecutar y no choque con un constraint del
-- mismo nombre en otra tabla.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_config_terms_by_type_is_object'
      AND conrelid = 'app_config'::regclass
  ) THEN
    ALTER TABLE app_config ADD CONSTRAINT app_config_terms_by_type_is_object
      CHECK (jsonb_typeof(terms_by_type) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_config_bank_info_by_type_is_object'
      AND conrelid = 'app_config'::regclass
  ) THEN
    ALTER TABLE app_config ADD CONSTRAINT app_config_bank_info_by_type_is_object
      CHECK (jsonb_typeof(bank_info_by_type) = 'object');
  END IF;
END $$;

-- ============================================================================
-- VERIFICACIONES NO DESTRUCTIVAS (ejecutar después de la migración de arriba)
-- Solo lectura — no modifican ninguna fila.
-- ============================================================================

-- 1-3. Ambas columnas existen, son jsonb, con el default correcto
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'app_config' AND column_name IN ('terms_by_type', 'bank_info_by_type');

-- 4-6. La fila actual conserva terms/bank_info intactos, y las columnas nuevas
-- arrancan en {}
SELECT id, terms, bank_info, terms_by_type, bank_info_by_type FROM app_config WHERE id = 1;
-- esperado: terms y bank_info EXACTAMENTE iguales a como estaban antes;
-- terms_by_type = '{}', bank_info_by_type = '{}'

-- 12. Confirmar que la policy de RLS de app_config no cambió: consultar el
-- catálogo de policies (informativo; la prueba real es que el UPDATE de la
-- app siga funcionando igual, ya verificado por comportamiento hoy).
SELECT polname, polcmd, polroles::regrole[]
FROM pg_policy
WHERE polrelid = 'app_config'::regclass;

-- ============================================================================
-- PRUEBAS TEMPORALES — TERMINAN EN ROLLBACK
-- Confirman que los valores válidos son aceptados. No dejan ningún dato
-- permanente: todo el bloque se revierte al final con ROLLBACK.
-- ============================================================================
BEGIN;

  -- objeto vacío aceptado
  UPDATE app_config SET terms_by_type = '{}'::jsonb, bank_info_by_type = '{}'::jsonb WHERE id = 1;

  -- claves instalacion/servicio/venta aceptadas
  UPDATE app_config SET terms_by_type = '{"instalacion":"a","servicio":"b","venta":"c"}'::jsonb WHERE id = 1;
  UPDATE app_config SET bank_info_by_type = '{"instalacion":"a","servicio":"b","venta":"c"}'::jsonb WHERE id = 1;

  -- clave futura arbitraria aceptada (no se restringe a los 3 tipos actuales)
  UPDATE app_config SET terms_by_type = '{"un_tipo_futuro_cualquiera":"x"}'::jsonb WHERE id = 1;

  -- verificación visual dentro de la misma transacción (opcional)
  SELECT terms_by_type, bank_info_by_type FROM app_config WHERE id = 1;

ROLLBACK; -- descarta todo lo anterior — app_config queda exactamente como estaba

-- ============================================================================
-- PRUEBAS DE RECHAZO — cada una debe fallar por el CHECK constraint.
-- Cada bloque es independiente (BEGIN ... ROLLBACK) para que el error de uno
-- nunca deje una transacción a medias ni afecte a los demás. ROLLBACK es
-- seguro de ejecutar incluso después de que el UPDATE haya fallado.
-- ============================================================================

-- Rechazo 1: un array JSON no es un objeto
BEGIN;
  UPDATE app_config SET terms_by_type = '["a","b"]'::jsonb WHERE id = 1; -- se espera que ESTO FALLE
ROLLBACK;

-- Rechazo 2: un string JSON no es un objeto
BEGIN;
  UPDATE app_config SET terms_by_type = '"solo texto"'::jsonb WHERE id = 1; -- se espera que ESTO FALLE
ROLLBACK;

-- Rechazo 3 (bank_info_by_type, mismo constraint, por completitud)
BEGIN;
  UPDATE app_config SET bank_info_by_type = '["a","b"]'::jsonb WHERE id = 1; -- se espera que ESTO FALLE
ROLLBACK;

-- ============================================================================
-- ROLLBACK MANUAL — NO EJECUTAR junto con la migración normal.
-- Solo ejecutar si se decide revertir por completo lo agregado en 6.3A.
-- ============================================================================
-- ALTER TABLE app_config DROP CONSTRAINT IF EXISTS app_config_terms_by_type_is_object;
-- ALTER TABLE app_config DROP CONSTRAINT IF EXISTS app_config_bank_info_by_type_is_object;
-- ALTER TABLE app_config DROP COLUMN IF EXISTS terms_by_type;
-- ALTER TABLE app_config DROP COLUMN IF EXISTS bank_info_by_type;
