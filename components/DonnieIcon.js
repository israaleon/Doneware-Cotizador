// components/DonnieIcon.js — iconos de línea del marco Donnie (trazos propios, sin dependencias).
const PATHS = {
  home: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  quote: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M12 11v6 M9 14h6',
  list: 'M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  calendar: 'M7 3v3 M17 3v3 M4 8h16 M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  users: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20 M10 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M20 20v-1.5a3.5 3.5 0 0 0-2.5-3.35 M15.5 5.2a3.5 3.5 0 0 1 0 6.6',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
  box: 'M21 8 12 3 3 8v8l9 5 9-5z M3 8l9 5 9-5 M12 13v8',
  settings: 'M4 7h10 M18 7h2 M4 17h2 M10 17h10 M16 5v4 M8 15v4',
  cash: 'M3 7h18v10H3z M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M6 10v4 M18 10v4',
  layers: 'M12 3 3 8l9 5 9-5z M3 12l9 5 9-5 M3 16l9 5 9-5',
  chart: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  trend: 'M3 17l6-6 4 4 8-8 M15 7h6v6',
  invoice: 'M7 3h10a2 2 0 0 1 2 2v16l-3-2-2 2-2-2-2 2-3-2V5a2 2 0 0 1 2-2z M9 8h6 M9 12h6 M9 16h3',
  truck: 'M3 6h11v10H3z M14 10h4l3 3v3h-7z M7 19a1.3 1.3 0 1 0 0-.01 M17 19a1.3 1.3 0 1 0 0-.01',
  plus: 'M12 5v14 M5 12h14',
  right: 'M9 6l6 6-6 6',
  grid: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  building: 'M5 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16 M15 10h3a1 1 0 0 1 1 1v10 M3 21h18 M9 8h2 M9 12h2 M9 16h2',
  logout: 'M10 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4 M15 8l4 4-4 4 M19 12H9',
  close: 'M6 6l12 12 M18 6L6 18',
  wrench: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  check: 'M9 11l3 3 8-8 M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h9',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  receipt: 'M7 3h10a2 2 0 0 1 2 2v16l-3-2-2 2-2-2-2 2-3-2V5a2 2 0 0 1 2-2z M9 8h6 M9 12h6',
  left: 'M15 6l-6 6 6 6',
  down: 'M6 9l6 6 6-6',
  first: 'M7 6v12 M18 6l-6 6 6 6',
  last: 'M17 6v12 M6 6l6 6-6 6',
  download: 'M12 4v11 M7 11l5 5 5-5 M5 20h14',
  tick: 'M5 12.5l4.5 4.5L19 7.5',
  star: 'M12 3.5l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.9l6.1-.8z',
}

export default function DonnieIcon({ name, className = '' }) {
  return (
    <svg className={`dn-ic ${className}`.trim()} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name] || ''} />
    </svg>
  )
}

// Papelera con tapa independiente: al pasar el mouse o enfocar el botón que la contiene (.dn-q-del) la tapa se abre (CSS en donnie.css).
export function DonnieTrash({ className = '' }) {
  return (
    <svg className={`dn-ic dn-trash ${className}`.trim()} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 9l1 11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-11 M10 12v5 M14 12v5" />
      <g className="dn-lid"><path d="M4 6.5h16 M9.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5" /></g>
    </svg>
  )
}
