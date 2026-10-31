// app/cotizador/nueva/page.js — N3-A (ronda Donnie): selección del tipo de cotización.
// Se llega desde la entrada del Cotizador («Nueva cotización»). Cada tarjeta abre el formulario existente (/cotizar) con el valor actual de quote_type
// (instalacion, servicio o venta) en ?tipo=. No hay modelo ni reglas nuevas: el formulario sigue decidiendo servicio requerido, textos y datos.
// El acceso directo a /cotizar (sin tipo), a las ediciones (?edit=) y a los enlaces con ?client= no pasa por aquí y se conserva.
import Link from 'next/link'
import DonnieIcon from '@/components/DonnieIcon'
import { QUOTE_TYPE_CARDS, quoteFormHref } from '@/lib/quoteTypes'

export const metadata = { title: 'Nueva cotización · Donnie' }

export default function SeleccionTipoCotizacion() {
  return (
    <div className="dn-home dn-entry">
      <div className="dn-entry-head">
        <p className="dn-crumb"><Link href="/cotizador">Cotizador</Link> <span aria-hidden="true">/</span> Nueva cotización</p>
        <h1>¿Qué tipo de cotización vas a hacer?</h1>
        <p>Elige el tipo para abrir el formulario con esa opción ya seleccionada. Podrás cambiarla dentro del formulario.</p>
      </div>
      <div className="dn-type-grid">
        {QUOTE_TYPE_CARDS.map((t) => (
          <Link key={t.value} href={quoteFormHref(t.value)} className="dn-type-card" data-type={t.value}>
            <span className="dn-entry-ico"><DonnieIcon name={t.icon} /></span>
            <span className="dn-entry-tx">
              <b>{t.label}</b>
              <small>{t.desc}</small>
              <em>{t.note}</em>
            </span>
            <span className="dn-entry-go">Elegir<DonnieIcon name="right" /></span>
          </Link>
        ))}
      </div>
    </div>
  )
}
