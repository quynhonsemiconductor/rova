import { defineConfig, loadEnv, type Plugin } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The dev server's settings come from the root `.env` (where the API's PORT and the storage STORAGE_ENDPOINT live), read
// here because Vite only puts VITE_-prefixed keys into `import.meta.env`. The process environment wins, as usual. The
// defaults are this stack's own ports.
const dotenv = { ...loadEnv('', path.resolve(__dirname, '../..'), ''), ...process.env }
const apiOrigin = dotenv.API_TARGET || `http://localhost:${dotenv.PORT || 3010}`
const storageOrigin = dotenv.STORAGE_ENDPOINT || 'http://localhost:4620'

/**
 * index.html's dev CSP and preconnect hint name the API and the storage node by their default ports. A second copy of the stack has
 * other ports, and the browser would block its API, so the dev server rewrites those origins to the configured ones. Served
 * only by `vite` (apply: 'serve'), so the production build keeps the file as written.
 */
export function devOrigins(html: string): string {
  return html
    .replace(/http:\/\/localhost:3000\b/g, apiOrigin)
    .replace(/http:\/\/localhost:4620\b/g, storageOrigin)
}

const devOriginsPlugin: Plugin = {
  name: 'dev-origins',
  apply: 'serve',
  transformIndexHtml: (html) => devOrigins(html),
}

/**
 * Modules that carry the User Guide's TEXT: its chapters and its table of contents.
 *
 * Every other built file is public — Pages serves `/assets/*` to anyone — and the guide is for
 * signed-in readers only. So any chunk holding one of these is written under `/guide-assets/js/`
 * instead, which `functions/guide-assets/_middleware.ts` puts behind the same session check as the
 * guide's screenshots. Only these chunks pay for the check; the rest of the app stays on the fast path.
 */
const GUIDE_TEXT = /[\\/]src[\\/]pages[\\/]guide[\\/](?:content[\\/]|model[\\/]toc)/

export const GUIDE_CHUNK_DIR = 'guide-assets/js'

const holdsGuideText = (moduleIds: readonly string[]) => moduleIds.some((id) => GUIDE_TEXT.test(id))

/** `chunkFileNames`: names every chunk but an entry, which `entryFileNames` names. */
export function chunkFileName(chunk: { moduleIds: readonly string[] }) {
  return holdsGuideText(chunk.moduleIds)
    ? `${GUIDE_CHUNK_DIR}/[name]-[hash].js`
    : 'assets/[name]-[hash].js'
}

/** A built file as `generateBundle` sees it, as far as `assertEntryIsPublic` reads it. */
interface BuiltFile {
  type: 'chunk' | 'asset'
  fileName: string
  isEntry?: boolean
  imports?: readonly string[]
  moduleIds?: readonly string[]
}

/**
 * Fails the build when guide text is part of what EVERY visitor loads: an entry, or a chunk an entry
 * imports statically. A signed-out visitor loads exactly that to reach the login page, so it can be
 * neither gated (they could not sign in) nor carry the guide (it would be public).
 *
 * Checked on the finished bundle, not in `chunkFileName`: an entry never passes through
 * `chunkFileNames` (Vite always sets `entryFileNames`), and a shared chunk is gated correctly by it
 * while still being loaded by the entry, which no per-chunk naming rule can see.
 */
export function assertEntryIsPublic(bundle: Readonly<Record<string, BuiltFile>>) {
  for (const entry of Object.values(bundle)) {
    if (entry.type !== 'chunk' || !entry.isEntry) continue
    const seen = new Set<string>()
    const queue = [entry.fileName]
    while (queue.length) {
      const file = bundle[queue.pop()!]
      if (!file || file.type !== 'chunk' || seen.has(file.fileName)) continue
      seen.add(file.fileName)
      if (file.fileName.startsWith(`${GUIDE_CHUNK_DIR}/`) || holdsGuideText(file.moduleIds ?? [])) {
        throw new Error(
          `User Guide text reaches the entry "${entry.fileName}" through "${file.fileName}". ` +
            'Every visitor loads it, signed in or not: import guide content lazily (`import()`).',
        )
      }
      queue.push(...(file.imports ?? []))
    }
  }
}

export const guideChunkGuard: Plugin = {
  name: 'guide-chunk-guard',
  apply: 'build',
  generateBundle: (_options, bundle) => assertEntryIsPublic(bundle),
}

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
export default defineConfig(({ mode, command }) => ({
  plugins: [react(), tailwindcss(), securityHeadersPlugin, devOriginsPlugin, guideChunkGuard],
  // The repo-root `.env` serves the SPA too, BUT ONLY FOR THE DEV SERVER (`vite`, mode `development`): Vite exposes only
  // `VITE_`-prefixed variables to the browser, so the API's secrets in that file never reach it, and `cp .env.example
  // .env` is the whole setup (VITE_DEV_LOGIN lives there). A `vite build` (any mode) and the unit tests keep the default
  // `envDir` (apps/web), so a laptop's root `.env` can never bake `VITE_DEV_LOGIN=true` into a bundle that is then deployed.
  envDir:
    command === 'serve' && mode === 'development' ? path.resolve(__dirname, '../..') : undefined,
  server: {
    host: '0.0.0.0',
    // 5173 (WEB_DEV_PORT in .env to change it) is the origin the rest of the stack is wired to (.env.example CORS_ORIGINS and APP_BASE_URL, whose
    // /api/auth/callback/microsoft is the Entra redirect URI, LocalStack's bucket CORS, Playwright's baseURL). strictPort: if another dev server holds it,
    // FAIL instead of silently moving to 5174, where the sign-in redirect and the upload bucket's CORS no longer match.
    port: Number(dotenv.WEB_DEV_PORT) || 5175,
    strictPort: true,
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/v1': {
        target: apiOrigin,
        changeOrigin: true,
        secure: false,
      },
      // identity 8 (Better Auth): sign-in, the Microsoft callback and sign-out, same-origin with the SPA.
      '/api/auth': {
        target: apiOrigin,
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
        chunkFileNames: chunkFileName,
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
