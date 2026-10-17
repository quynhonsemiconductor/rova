import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Security headers plugin for dev server
// (Production deployments should configure these at the CDN/reverse-proxy layer)
const securityHeadersPlugin: Plugin = {
  name: 'security-headers',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('X-Frame-Options', 'DENY') // clickjacking
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
      res.setHeader('X-XSS-Protection', '1; mode=block') // legacy IE/Edge
      next()
    })
  },
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), securityHeadersPlugin],
  // The repo-root `.env` serves the SPA too: Vite exposes ONLY `VITE_`-prefixed variables to the browser, so the API's
  // secrets in that file never reach it, and `cp .env.example .env` is the whole setup (VITE_DEV_LOGIN lives there).
  envDir: path.resolve(__dirname, '../..'),
  server: {
    host: '0.0.0.0',
    // 5173 is the origin the rest of the stack is wired to (.env.example CORS_ORIGINS, APP_BASE_URL and
    // ENTRA_REDIRECT_URI, LocalStack's bucket CORS, Playwright's baseURL). strictPort: if another dev server holds it,
    // FAIL instead of silently moving to 5174, where the sign-in redirect and the upload bucket's CORS no longer match.
    port: 5173,
    strictPort: true,
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/v1': {
        target: process.env.API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // Disable source maps in production — prevents exposing source code to end users
    sourcemap: mode === 'production' ? false : 'inline',
    // Chunk splitting — vendor libs separately for better cache efficiency
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react'
          }
          if (id.includes('@tanstack/react-router')) return 'vendor-router'
          if (id.includes('@tanstack/react-query')) return 'vendor-query'
        },
      },
    },
  },
}))
