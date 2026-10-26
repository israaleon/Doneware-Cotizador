// lib/publicRoutes.js — única ruta SIN sesión de la app: la página pública de una cotización, /q/{token}.
// Solo coincide con exactamente un segmento después de /q/ (con o sin barra final). No abre /q, /q/ ni /q/a/b ni ninguna otra ruta;
// un token mal formado sí llega a la página, que lo muestra como «enlace no válido» sin consultar nada raro (la API decide).
const PUBLIC_QUOTE_PATH_RE = /^\/q\/[^/?#]+\/?$/

export function isPublicQuotePath(pathname) {
  return typeof pathname === 'string' && PUBLIC_QUOTE_PATH_RE.test(pathname)
}
