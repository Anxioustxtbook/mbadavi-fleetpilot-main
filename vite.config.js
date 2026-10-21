import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // './' makes the built files load from relative paths, so the app works from
  // any folder: the Electron .exe (file://) and the portable folder alike.
  base: './',
  plugins: [
    // src/main.js imports 'virtual:pwa-register', which only exists while this
    // plugin is loaded. Without it the build/dev server fails and the UI never
    // gets its JavaScript, so nothing responds to clicks.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // src/main.js registers the service worker itself
      includeAssets: ['pwa-icon.svg'],
      manifest: {
        name: 'Mbadavi Fleetpilot',
        short_name: 'Fleetpilot',
        description: 'Fleet and rental ledger for Mbadavi Investment Limited.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#0B0E12',
        theme_color: '#0B0E12',
        lang: 'en',
        icons: [
          { src: 'pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }
        ]
      },
      workbox: {
        navigateFallback: 'index.html'
      }
    })
  ]
});
