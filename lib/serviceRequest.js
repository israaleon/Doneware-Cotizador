// lib/serviceRequest.js
// Fase 6.7C-1.3c / Etapa 2.2b — tiempo límite de ESPERA para las peticiones de las pantallas de servicios.
//
// Sin React ni credenciales. No reintenta, no inicia otra petición como recuperación y no interpreta el resultado.
//
// IMPORTANTE — cancelar la ESPERA no es cancelar la OPERACIÓN:
//   Al vencer el plazo la interfaz deja de esperar y aborta la petición del NAVEGADOR (AbortController). Eso NO garantiza que el
//   servidor deje de trabajar: la ruta puede seguir ejecutándose y crear, modificar o eliminar el evento de Google Calendar y/o
//   guardar en Supabase aunque el navegador ya no escuche. Por eso un plazo vencido se comunica siempre como resultado
//   DESCONOCIDO (lib/serviceApiMessages.js), nunca como "falló" ni como "se canceló".

// Plazo por defecto. Las rutas encadenan varias llamadas a Google y a Supabase (normalmente unos pocos segundos); 30 s es
// holgado para una operación normal y evita dejar la pantalla esperando indefinidamente. No cambia ningún límite de Vercel.
export const SERVICE_REQUEST_TIMEOUT_MS = 30000

export class RequestTimeoutError extends Error {
  constructor() {
    super('request timeout')
    this.name = 'RequestTimeoutError'
  }
}

// Ejecuta task(signal) y devuelve su resultado, o rechaza con RequestTimeoutError si no termina en `ms`.
//  - `signal` se aborta al vencer el plazo; task puede pasarlo a fetch / .abortSignal() (opcional: puede ignorarlo).
//  - La espera termina SIEMPRE al vencer el plazo, aunque task ignore la señal y nunca resuelva (Promise.race).
//  - Si task termina después de vencido el plazo, su resultado o error se descarta: Promise.race ya atiende ambas promesas, así que
//    un rechazo tardío (p. ej. AbortError) no genera "unhandled rejection".
export function withDeadline(task, ms = SERVICE_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new RequestTimeoutError()) }, ms)
  })
  let running
  try {
    running = Promise.resolve(task(controller.signal))
  } catch (e) {
    running = Promise.reject(e)
  }
  return Promise.race([running, deadline]).finally(() => clearTimeout(timer))
}

// POST/GET a una ruta propia con plazo. Devuelve { ok, status, body } donde body es el JSON como objeto, o {} si la
// respuesta no es un objeto JSON (HTML de infraestructura, texto, vacío...). Lanza ante red caída, plazo vencido...
// El plazo cubre también la lectura del cuerpo.
export function fetchServiceApi(url, init, ms = SERVICE_REQUEST_TIMEOUT_MS) {
  return withDeadline(async (signal) => {
    const res = await fetch(url, { ...init, signal })
    let body = {}
    try {
      const parsed = await res.json()
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed
    } catch {
      body = {}
    }
    return { ok: res.ok, status: res.status, body }
  }, ms)
}
