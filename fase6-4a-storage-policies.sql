-- ============================================================================
-- FASE 6.4A — Storage policies para quote_documents, acotadas al namespace
-- lógico "quotes/..." dentro del bucket.
--
-- El bucket `quote_documents` YA EXISTE (privado, creado en Fase 2) y NO se
-- toca aquí — esta migración solo agrega policies sobre storage.objects.
--
-- Modelo de acceso: negocio único compartido (2 usuarios de staff), sin
-- ownership por usuario — mismo patrón ya usado en el resto del proyecto
-- (clients/quotes/etc. son de acceso compartido para authenticated).
-- ============================================================================

-- ---------- 0. VERIFICACIÓN PREVIA — ejecutar esto primero, solo lectura ----------
-- Debe devolver exactamente: {quotes,abc-123}
-- Si storage.foldername no existe en esta instalación o el resultado no es
-- ese, DETENTE — no continúes con la sección 1.
SELECT storage.foldername('quotes/abc-123/logo') AS prueba_foldername;

-- ---------- 1. Policies ----------
-- Namespace: bucket_id = 'quote_documents' Y el primer segmento de carpeta
-- del path debe ser exactamente 'quotes'. storage.foldername(name) devuelve
-- un text[] con los segmentos de carpeta (todo menos el nombre de archivo
-- final); (storage.foldername(name))[1] es el primer segmento.
--   'quotes/<uuid>/logo'      -> foldername = {quotes,<uuid>}      -> [1]='quotes'  -> PASA
--   'quotes/<uuid>/quote.pdf' -> foldername = {quotes,<uuid>}      -> [1]='quotes'  -> PASA (6.5)
--   'private/foo'             -> foldername = {private}           -> [1]='private' -> NO PASA
--   'temp/test'               -> foldername = {temp}              -> [1]='temp'    -> NO PASA
--   'avatars/x'               -> foldername = {avatars}           -> [1]='avatars' -> NO PASA
--   'foo' / 'logo' (sin carpeta) -> foldername = {}                -> [1]=NULL      -> NO PASA
--
-- Nombres explícitos y estables — se eliminan primero solo si ya existen CON
-- ESE NOMBRE EXACTO (exclusivo de esta migración), para que el script sea
-- repetible sin duplicar policies ni tocar ninguna policy ajena.

DROP POLICY IF EXISTS quote_documents_quotes_select_authenticated ON storage.objects;
CREATE POLICY quote_documents_quotes_select_authenticated ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'quote_documents'
    AND (storage.foldername(name))[1] = 'quotes'
  );

DROP POLICY IF EXISTS quote_documents_quotes_insert_authenticated ON storage.objects;
CREATE POLICY quote_documents_quotes_insert_authenticated ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'quote_documents'
    AND (storage.foldername(name))[1] = 'quotes'
  );

-- UPDATE necesita USING (qué filas existentes se pueden tocar) Y WITH CHECK
-- (que el valor resultante después del update siga cumpliendo el namespace
-- — evita que alguien "mueva" un objeto fuera de quotes/ vía UPDATE).
DROP POLICY IF EXISTS quote_documents_quotes_update_authenticated ON storage.objects;
CREATE POLICY quote_documents_quotes_update_authenticated ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'quote_documents'
    AND (storage.foldername(name))[1] = 'quotes'
  )
  WITH CHECK (
    bucket_id = 'quote_documents'
    AND (storage.foldername(name))[1] = 'quotes'
  );

DROP POLICY IF EXISTS quote_documents_quotes_delete_authenticated ON storage.objects;
CREATE POLICY quote_documents_quotes_delete_authenticated ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'quote_documents'
    AND (storage.foldername(name))[1] = 'quotes'
  );

-- ============================================================================
-- SQL DE INSPECCIÓN / VERIFICACIÓN — solo lectura, ejecutar después de lo anterior
-- ============================================================================

-- Confirma que existen exactamente las 4 policies nuevas, con su comando,
-- roles, y las expresiones USING/WITH CHECK correctas (namespace incluido).
SELECT
  pol.polname AS policy_name,
  CASE pol.polcmd
    WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
    WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
    ELSE pol.polcmd::text
  END AS command,
  pol.polroles::regrole[] AS roles,
  pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
  pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check_expr
FROM pg_policy pol
WHERE pol.polrelid = 'storage.objects'::regclass
  AND pol.polname LIKE 'quote_documents_quotes_%'
ORDER BY pol.polname;

-- Confirmar que el bucket NO fue tocado (debe seguir privado, sin cambios)
SELECT id, public FROM storage.buckets WHERE id = 'quote_documents';

-- ============================================================================
-- ROLLBACK MANUAL — NO EJECUTAR junto con la migración normal.
-- Elimina EXCLUSIVAMENTE las 4 policies creadas por 6.4A. No toca el bucket,
-- ningún objeto, ninguna otra policy ni ninguna tabla.
-- ============================================================================
-- DROP POLICY IF EXISTS quote_documents_quotes_select_authenticated ON storage.objects;
-- DROP POLICY IF EXISTS quote_documents_quotes_insert_authenticated ON storage.objects;
-- DROP POLICY IF EXISTS quote_documents_quotes_update_authenticated ON storage.objects;
-- DROP POLICY IF EXISTS quote_documents_quotes_delete_authenticated ON storage.objects;
