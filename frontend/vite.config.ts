import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      // SSE streaming endpoint - needs special handling
      '/api/grade-stream': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        // Critical for SSE: disable response buffering
        selfHandleResponse: false,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            // Ensure no buffering for SSE
            proxyRes.headers['cache-control'] = 'no-cache';
            proxyRes.headers['x-accel-buffering'] = 'no';
          });
        },
      },
      // Regular API endpoints
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
