import { defineConfig } from 'vitest/config'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Build stamp — surfaced in the app footer so you can confirm a deploy actually
// shipped the commit you expect (the PWA service worker caches aggressively, so a
// stale page is otherwise hard to spot). SHA falls back to the CI-provided
// GITHUB_SHA, then 'dev', when git isn't available.
function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return (process.env.GITHUB_SHA ?? 'dev').slice(0, 7)
  }
}
const pkgVersion = JSON.parse(readFileSync('./package.json', 'utf8')).version as string
const BUILD_SHA = gitSha()
const BUILD_TIME = new Date().toISOString()

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  // GitHub Pages serves the app under /poker/ — CI sets BASE_PATH (see
  // .github/workflows/deploy.yml). Local dev/preview stay at /.
  base: process.env.BASE_PATH ?? '/',
  plugins: [
    react(),
    // Installable, offline-capable PWA. The app is already 100% local, so caching
    // the built assets in a service worker means it runs with no network at all —
    // and can be "Add to Home Screen"-ed on a phone as a standalone app.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons.svg'],
      // enabled in dev too, so the install prompt / manifest work over `npm run dev`
      // when testing on a phone (over localhost or a tunnel).
      devOptions: { enabled: true },
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'], cleanupOutdatedCaches: true },
      manifest: {
        name: 'Poker Trainer',
        short_name: 'Poker',
        description: '6-max No-Limit Hold\'em trainer — play vs AI, drill ranges, equity & bankroll variance. 100% local.',
        theme_color: '#0f7a48',
        background_color: '#0a0f0d',
        display: 'standalone',
        orientation: 'any',
        // relative → correct at both / (local) and /poker/ (GitHub Pages)
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
})
