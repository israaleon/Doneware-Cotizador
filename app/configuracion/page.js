// app/configuracion/page.js
'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

export default function ConfiguracionPage() {
  const [config, setConfig] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supabase.from('app_config').select('*').eq('id', 1).single().then(({ data }) => setConfig(data))
  }, [])

  if (!config) return <div>Cargando…</div>

  function set(field, value) { setConfig((c) => ({ ...c, [field]: value })) }

  async function handleLogoUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    if (file.size > 1.5 * 1024 * 1024) { alert('La imagen pesa demasiado. Usa un archivo menor a 1.5 MB.'); return }
    const path = `logo-${Date.now()}.${file.name.split('.').pop()}`
    const { error } = await supabase.storage.from('logos').upload(path, file, { upsert: true })
    if (error) { alert('No se pudo subir el logo: ' + error.message); return }
    const { data } = supabase.storage.from('logos').getPublicUrl(path)
    await supabase.from('app_config').update({ logo_url: data.publicUrl }).eq('id', 1)
    set('logo_url', data.publicUrl)
  }

  async function save() {
    setSaving(true)
    const { id, next_quote_number, next_receipt_number, ...rest } = config
    const { error } = await supabase.from('app_config').update(rest).eq('id', 1)
    setSaving(false)
    if (error) alert('No se pudo guardar: ' + error.message)
    else alert('Configuración guardada.')
  }

  return (
    <div>
      <h2 className="pagetitle">Configuración</h2>
      <div className="pagesub">Estos datos aparecen en tus cotizaciones, recibos y mensajes.</div>

      <div className="panel">
        <h3>Datos de la empresa</h3>
        <div className="fieldrow">
          <div className="field"><label>Nombre de la empresa</label><input value={config.company_name || ''} onChange={(e) => set('company_name', e.target.value)} /></div>
          <div className="field"><label>Teléfono</label><input value={config.phone || ''} onChange={(e) => set('phone', e.target.value)} /></div>
        </div>
        <div className="fieldrow">
          <div className="field"><label>Correo</label><input value={config.email || ''} onChange={(e) => set('email', e.target.value)} /></div>
          <div className="field"><label>Dirección</label><input value={config.address || ''} onChange={(e) => set('address', e.target.value)} /></div>
        </div>
      </div>

      <div className="panel">
        <h3>Logotipo</h3>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ width: 64, height: 64, border: '1px solid var(--line)', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: '#FAFAFA' }}>
            {config.logo_url ? <img src={config.logo_url} alt="" style={{ maxWidth: '100%', maxHeight: '100%' }} /> : <span className="muted" style={{ fontSize: 10 }}>Sin logo</span>}
          </div>
          <div>
            <input type="file" accept="image/png,image/jpeg" onChange={handleLogoUpload} />
            <div className="helptext" style={{ marginTop: 6, marginBottom: 0 }}>PNG o JPG, menor a 1.5 MB. Se sube a Supabase Storage y se guarda al instante.</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>Impuestos y vigencia</h3>
        <div className="fieldrow">
          <div className="field">
            <label><input type="checkbox" checked={!!config.apply_iva} onChange={(e) => set('apply_iva', e.target.checked)} style={{ width: 'auto', marginRight: 6 }} />Aplicar IVA</label>
            <input type="number" min="0" step="0.1" value={config.iva_rate} onChange={(e) => set('iva_rate', parseFloat(e.target.value) || 0)} style={{ marginTop: 6 }} />
          </div>
          <div className="field"><label>Vigencia por defecto (días)</label><input type="number" min="1" value={config.valid_days} onChange={(e) => set('valid_days', parseInt(e.target.value) || 1)} /></div>
        </div>
      </div>

      <div className="panel">
        <h3>Textos del documento</h3>
        <div className="field"><label>Términos y condiciones (cotización)</label><textarea value={config.terms || ''} onChange={(e) => set('terms', e.target.value)} /></div>
        <div className="field">
          <label>Datos de pago</label>
          <textarea value={config.bank_info || ''} onChange={(e) => set('bank_info', e.target.value)} />
        </div>
        <div className="helptext" style={{ marginBottom: 0 }}>
          Los datos de pago ahora se muestran en el PDF de la <strong>cotización</strong> (para que el cliente sepa cómo pagar si decide contratar)
          y ya no aparecen en el PDF del <strong>recibo</strong>, que solo confirma que el servicio quedó pagado.
        </div>
      </div>

      <div className="panel">
        <h3>Plantillas para cotizaciones</h3>
        <div className="helptext">Variables: {'{cliente} {empresa} {folio} {tipo} {Tipo} {total} {vigencia} {telefono_empresa} {referencia}'}</div>
        <div className="field"><label>Asunto del correo</label><input value={config.email_subject_template || ''} onChange={(e) => set('email_subject_template', e.target.value)} /></div>
        <div className="field"><label>Cuerpo del correo</label><textarea style={{ minHeight: 130 }} value={config.email_body_template || ''} onChange={(e) => set('email_body_template', e.target.value)} /></div>
        <div className="field"><label>Mensaje de WhatsApp</label><textarea value={config.whatsapp_template || ''} onChange={(e) => set('whatsapp_template', e.target.value)} /></div>
      </div>

      <div className="panel">
        <h3>Plantillas para recibos</h3>
        <div className="helptext">Se usan al enviar un registro marcado como "recibo" — normalmente un tono de confirmación, no de propuesta.</div>
        <div className="field"><label>Asunto del correo</label><input value={config.receipt_email_subject_template || ''} onChange={(e) => set('receipt_email_subject_template', e.target.value)} /></div>
        <div className="field"><label>Cuerpo del correo</label><textarea style={{ minHeight: 130 }} value={config.receipt_email_body_template || ''} onChange={(e) => set('receipt_email_body_template', e.target.value)} /></div>
        <div className="field"><label>Mensaje de WhatsApp</label><textarea value={config.receipt_whatsapp_template || ''} onChange={(e) => set('receipt_whatsapp_template', e.target.value)} /></div>
      </div>

      <div className="savebar">
        <button className="btn teal" disabled={saving} onClick={save}>{saving ? 'Guardando…' : 'Guardar configuración'}</button>
      </div>
    </div>
  )
}
