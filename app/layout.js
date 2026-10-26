// app/layout.js
import './globals.css'
import AuthGate from '@/components/AuthGate'
import Sidebar from '@/components/Sidebar'

export const metadata = { title: 'Cotizador' }
export const viewport = { width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>
        <AuthGate sidebar={<Sidebar />}>{children}</AuthGate>
      </body>
    </html>
  )
}
