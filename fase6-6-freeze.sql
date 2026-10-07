-- ============================================================================
-- FASE 6.6A-2 — "FREEZE" de escritura directa sobre quotes/recibos.
--
-- 🔴 NO EJECUTAR TODAVÍA. NO ejecutar hasta cerrar 6.6B (UI migrada a
-- contract_quote/cancel_quote_contract Y LegacyContractedEditForm retirado).
--
-- Motivo del bloqueo, confirmado por grep antes de escribir este archivo:
--   app/cotizar/page.js:168 —
--     const { error: recError } = await supabase.from('quotes')
--       .update(receiptPayload).eq('status', 'recibo').eq('related_folio', editingRec.folio)
--   Esta es la ÚNICA escritura directa sobre un recibo en todo el repo hoy
--   (LegacyContractedEditForm.saveQuote(), sincroniza el recibo al editar una
--   contratada legacy). Si este archivo se ejecuta antes de retirar ese
--   flujo, esa línea empezará a fallar en producción. Por eso vive en un
--   archivo separado del de 6.6A-1 y no se ejecuta en el mismo momento.
--
-- Las funciones contract_quote/cancel_quote_contract (fase6-6a-migracion.sql)
-- son SECURITY DEFINER: no les afecta ninguna policy de esta migración,
-- vengan antes o después. Este freeze solo bloquea escrituras DIRECTAS desde
-- JS/PostgREST fuera de esas dos funciones.
-- ============================================================================


-- ---------- 1. UPDATE — solo cotizaciones en lifecycle_status='cotizacion' ----------
-- Deliberadamente NO incluye ninguna condición que permita actualizar un
-- recibo directamente (ver punto 16 del diseño): un recibo, sea 'vigente' o
-- 'cancelado', queda completamente fuera de este permiso — solo
-- cancel_quote_contract (SECURITY DEFINER) puede tocar receipt_status.
DROP POLICY IF EXISTS quotes_update_lock ON quotes;
CREATE POLICY quotes_update_lock ON quotes AS RESTRICTIVE FOR UPDATE
  USING (status = 'cotizacion' AND lifecycle_status = 'cotizacion')
  WITH CHECK (status = 'cotizacion' AND lifecycle_status = 'cotizacion');


-- ---------- 2. DELETE — solo precontrato nunca contratada ----------
-- Refuerza a nivel de base de datos lo que app/historial/page.js:isDeletionBlocked
-- ya hace a nivel de aplicación desde Fase 6.5.1 — esa guarda de UI/JS deja
-- de ser la única línea de defensa. contracted=false se exige además de
-- lifecycle_status='cotizacion' como cinturón y tirantes: ninguna fila que
-- alguna vez pasó por contract_quote puede eliminarse físicamente, ni
-- siquiera si por algún error futuro su lifecycle_status quedara mal.
DROP POLICY IF EXISTS quotes_delete_lock ON quotes;
CREATE POLICY quotes_delete_lock ON quotes AS RESTRICTIVE FOR DELETE
  USING (status = 'cotizacion' AND lifecycle_status = 'cotizacion' AND contracted = false);


-- ============================================================================
-- SQL DE VERIFICACIÓN — solo lectura, ejecutar después de activar el freeze
-- ============================================================================

-- Confirma que ambas policies existen, con el comando y las expresiones correctas.
SELECT polname, polcmd, polpermissive, pg_get_expr(polqual, polrelid) AS using_expr,
       pg_get_expr(polwithcheck, polrelid) AS with_check_expr
FROM pg_policy
WHERE polrelid = 'quotes'::regclass AND polname IN ('quotes_update_lock', 'quotes_delete_lock');
-- polpermissive debe ser 'f' (RESTRICTIVE) en ambas.

-- Prueba funcional (ejecutar desde la app, no aquí): confirmar que
-- contract_quote/cancel_quote_contract siguen funcionando con normalidad
-- (SECURITY DEFINER bypasa esto), y que un UPDATE/DELETE directo sobre una
-- contratada/cancelada/recibo ahora es rechazado por RLS.


-- ============================================================================
-- ROLLBACK MANUAL — NO EJECUTAR junto con la activación normal.
-- ============================================================================
-- DROP POLICY IF EXISTS quotes_update_lock ON quotes;
-- DROP POLICY IF EXISTS quotes_delete_lock ON quotes;
-- -- No hay más nada que revertir: este archivo no toca datos, solo agrega
-- -- dos policies RESTRICTIVE; quitarlas devuelve exactamente el
-- -- comportamiento previo (gobernado por la policy PERMISSIVE existente,
-- -- que este archivo nunca modifica ni necesita conocer).
