import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const TUNNEL_HOST = 'troub-port-tool.loca.lt'

// Served under /tool-identifier/ via the hub proxy (see hubpage public/_redirects).
export default defineConfig({
  base: '/tool-identifier/',
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: [TUNNEL_HOST, '.loca.lt'],
    hmr: {
      host: TUNNEL_HOST,
      protocol: 'wss',
      clientPort: 443,
    },
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
    allowedHosts: [TUNNEL_HOST, '.loca.lt'],
  },
})
