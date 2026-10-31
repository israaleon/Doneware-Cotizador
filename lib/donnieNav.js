// lib/donnieNav.js — N2 (ronda Donnie): estructura de navegación del marco interno. Módulo puro: sin React, sin red, sin datos.
// state 'ok'   = el módulo existe hoy y se abre en su ruta actual.
// state 'soon' = módulo futuro: se muestra identificado como próximo, sin ruta ni acción (no hay función que implementar todavía).

export const NAV_CATEGORIES = ['Herramientas', 'Agenda', 'Métricas', 'Gestión interna', 'Finanzas', 'Almacén', 'Personal']

export const NAV_MODULES = [
  { id: 'inicio', label: 'Inicio', icon: 'home', href: '/', state: 'ok', cat: null, desc: 'Resumen y accesos' },
  // «Cotizador» abre la pantalla de entrada (/cotizador) con las dos opciones: Nueva cotización (/cotizar, el formulario de siempre) y Mis cotizaciones (/historial).
  { id: 'cotizador', label: 'Cotizador', icon: 'quote', href: '/cotizador', alsoActive: ['/cotizar'], state: 'ok', cat: 'Herramientas', desc: 'Nueva cotización o Mis cotizaciones' },
  { id: 'mis-cotizaciones', label: 'Mis cotizaciones', icon: 'list', href: '/historial', state: 'ok', cat: 'Herramientas', desc: 'Seguimiento y recibos' },
  { id: 'clientes', label: 'Clientes', icon: 'users', href: '/clientes', state: 'ok', cat: 'Herramientas', desc: 'Fichas, direcciones y contactos' },
  { id: 'catalogo', label: 'Catálogo y precios', icon: 'box', href: '/catalogo', state: 'ok', cat: 'Herramientas', desc: 'Productos y servicios' },
  { id: 'agenda', label: 'Agenda de servicios', icon: 'calendar', href: '/servicios', state: 'ok', cat: 'Agenda', desc: 'Citas e instalaciones' },
  { id: 'mi-negocio', label: 'Mi negocio', icon: 'chart', state: 'soon', cat: 'Métricas', desc: 'Tu dashboard principal del negocio' },
  { id: 'operaciones', label: 'Operaciones', icon: 'target', state: 'soon', cat: 'Gestión interna', desc: 'Actividades, metas, equipos y planners internos' },
  { id: 'pagos', label: 'Pagos', icon: 'cash', state: 'soon', cat: 'Finanzas', desc: 'Registra y verifica cobros' },
  { id: 'ventas', label: 'Ventas', icon: 'trend', state: 'soon', cat: 'Finanzas', desc: 'Alcance por definir' },
  { id: 'facturacion', label: 'Facturación', icon: 'invoice', state: 'soon', cat: 'Finanzas', desc: 'Facturas electrónicas de los servicios vendidos' },
  { id: 'inventario', label: 'Inventario', icon: 'layers', state: 'soon', cat: 'Almacén', desc: 'Existencias, entradas y salidas' },
  { id: 'entregas', label: 'Entregas y reservas', icon: 'truck', state: 'soon', cat: 'Almacén', desc: 'Aparta y entrega productos' },
  { id: 'mi-perfil', label: 'Mi perfil', icon: 'user', state: 'soon', cat: 'Personal', desc: 'Tu nombre y foto de perfil' },
  { id: 'ajustes', label: 'Ajustes', icon: 'settings', href: '/configuracion', state: 'ok', cat: 'Ajustes', desc: 'Empresa, Datos, Plantillas, Herramientas' },
]

export const moduleById = (id) => NAV_MODULES.find((m) => m.id === id)
export const modulesByCategory = (cat) => NAV_MODULES.filter((m) => m.cat === cat)

// Accesos rápidos de Inicio: solo Herramientas, Agenda y Ajustes (los módulos próximos no se ofrecen aquí).
export const QUICK_ACCESS = [...modulesByCategory('Herramientas'), ...modulesByCategory('Agenda'), ...modulesByCategory('Ajustes')]

// Módulo activo según la ruta. «Inicio» solo es la raíz; el resto coincide con su ruta y con las subrutas
// (/servicios/nuevo, /servicios/[id], /clientes/[id]); alsoActive agrega rutas que también pertenecen al módulo (el formulario /cotizar es del Cotizador). Las rutas públicas y /login no pasan por aquí.
export function isModuleActive(mod, pathname) {
  if (!mod || !mod.href || typeof pathname !== 'string') return false
  if (mod.href === '/') return pathname === '/'
  return [mod.href, ...(mod.alsoActive || [])].some((h) => pathname === h || pathname.startsWith(h + '/'))
}

// Destinos que SÍ llevan a una pantalla (los módulos próximos no tienen ruta).
export const navigableHrefs = () => NAV_MODULES.filter((m) => m.state === 'ok').map((m) => m.href)
