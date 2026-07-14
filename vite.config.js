import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const TUNNEL_HOST = 'troub-port-tool.loca.lt'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: [TUNNEL_HOST, '.loca.lt'],
    // Tunnel URLs need HMR websocket details or the client can hang blank.
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
