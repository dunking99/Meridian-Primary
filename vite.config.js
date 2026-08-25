import os from 'os'
import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Vite's dependency cache is written, deleted and re-created constantly. Inside
// a OneDrive-synced folder the sync client keeps its own handle open on those
// files, and Windows then refuses the rename with EPERM — which is what has
// been killing the dev server. Keeping the cache in the OS temp directory takes
// it out of OneDrive's reach entirely; nothing in it is worth syncing anyway.
const cacheDir = path.join(os.tmpdir(), 'meridian-vite-cache')

export default defineConfig({
  cacheDir,
  server: {
    watch: {
      // OneDrive writes sidecar and placeholder files next to real ones while
      // syncing. Watching them wakes the HMR loop and can catch a file
      // mid-write, so they are ignored outright.
      ignored: [
        '**/.git/**',
        '**/node_modules/**',
        '**/*.tmp',
        '**/*.laccdb',
        '**/~$*',
        '**/.~*',
        '**/*.db',
        '**/*.db-shm',
        '**/*.db-wal',
      ],
      // Windows + a network-backed folder is exactly the case where native
      // filesystem events go missing. Polling is slower but it is reliable,
      // and on a project this size the cost is not noticeable.
      usePolling: process.platform === 'win32',
      interval: 400,
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Meridian Trading Terminal',
        short_name: 'Meridian',
        description: 'Professional trading intelligence terminal',
        theme_color: '#060810',
        background_color: '#060810',
        display: 'standalone',
        orientation: 'landscape',
        scope: '/',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      }
    })
  ]
})
