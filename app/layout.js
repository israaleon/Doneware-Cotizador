// app/layout.js
import './globals.css'
import AuthGate from '@/components/AuthGate'
import Sidebar from '@/components/Sidebar'

export const metadata = { title: 'Cotizador' }

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>
        <AuthGate>
          <div className="app-shell">
            <Sidebar />
            <div className="main">{children}</div>
          </div>
        </AuthGate>
      </body>
    </html>
  )
}
