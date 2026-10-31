// app/layout.js
import './globals.css'
import './donnie.css'
import AuthGate from '@/components/AuthGate'
import Sidebar from '@/components/Sidebar'
import Topbar from '@/components/Topbar'

export const metadata = { title: 'Donnie' }
export const viewport = { width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>
        <AuthGate sidebar={<Sidebar />} topbar={<Topbar />}>{children}</AuthGate>
      </body>
    </html>
  )
}
