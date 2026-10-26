// app/q/[token]/error.js — límite de errores de la página pública: mensaje genérico, sin detalles técnicos ni registro de nada.
'use client'

export default function PublicQuoteError({ reset }) {
  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '48px 20px', fontFamily: 'inherit' }}>
      <h1 style={{ fontSize: 22, margin: '0 0 10px' }}>No pudimos mostrar la cotización</h1>
      <p style={{ color: '#5B6B7C', margin: '0 0 18px' }}>Ocurrió un problema inesperado. Puedes intentarlo de nuevo.</p>
      <button type="button" onClick={() => reset()} style={{ padding: '12px 18px', borderRadius: 8, border: 0, background: '#151B23', color: '#fff', fontSize: 15, cursor: 'pointer' }}>Reintentar</button>
    </div>
  )
}
