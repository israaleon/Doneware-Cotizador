// app/cotizador/page.js — entrada del Cotizador (N2, ronda Donnie): las dos opciones del módulo.
// «Nueva cotización» abre la selección del tipo de cotización (/cotizador/nueva, N3-A) y de ahí el formulario de siempre (/cotizar); «Mis cotizaciones» abre la lista de siempre (/historial).
// No se crea ni cambia ninguna regla.
import Link from 'next/link'
import DonnieIcon from '@/components/DonnieIcon'

export const metadata = { title: 'Cotizador · Donnie' }

export default function CotizadorEntrada() {
  return (
    <div className="dn-home dn-entry">
      <div className="dn-entry-head">
        <h1>Cotizador</h1>
        <p>Elige cómo quieres empezar.</p>
      </div>
      <div className="dn-entry-grid">
        <Link href="/cotizador/nueva" className="dn-entry-card dn-entry-primary">
          <span className="dn-entry-ico"><DonnieIcon name="quote" /></span>
          <span className="dn-entry-tx">
            <b>Nueva cotización</b>
            <small>Crea una cotización para un cliente, con sus productos y servicios, y publícala.</small>
          </span>
          <span className="dn-entry-go">Empezar<DonnieIcon name="right" /></span>
        </Link>
        <Link href="/historial" className="dn-entry-card">
          <span className="dn-entry-ico"><DonnieIcon name="list" /></span>
          <span className="dn-entry-tx">
            <b>Mis cotizaciones</b>
            <small>Consulta el seguimiento, los recibos, los envíos y los enlaces de tus cotizaciones.</small>
          </span>
          <span className="dn-entry-go">Abrir<DonnieIcon name="right" /></span>
        </Link>
      </div>
    </div>
  )
}
