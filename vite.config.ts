import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
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
        start_url: '/',
        scope: '/',
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
