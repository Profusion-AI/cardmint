import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

export default defineConfig({
  root: 'src/dashboard',
  publicDir: '../../public', // Corrected relative path from src/dashboard
  server: {
    port: 5173,
    strictPort: false, // Allow automatic port selection if 5173 is busy
    host: true, // Allow LAN access for testing
    // Enable HTTPS for haptic feedback support
    https: {
      key: fs.readFileSync(path.resolve('.cert/localhost-key.pem')),
      cert: fs.readFileSync(path.resolve('.cert/localhost-cert.pem'))
    },
    // Enable polling for VM/network shares if needed
    // watch: { usePolling: true, interval: 200 },
    proxy: {
      // Proxy API requests to the backend server
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
      // Proxy WebSocket connections
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
      }
    },
    // Configure routing for dashboard navigation  
    middlewareMode: false,
    fs: {
      strict: false
    }
  },
  build: {
    outDir: '../../public/dashboard',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: 'src/dashboard/index.html',
        processing: 'src/dashboard/processing-status.html',
        verification: 'src/dashboard/verification.html',
        ensemble: 'src/dashboard/ensemble-dashboard.html',
        navigation: 'src/dashboard/navigation.html',
      },
    },
  },
  // Add SPA fallback for development
  appType: 'spa',
  // Ensure proper MIME types for static assets
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV === 'development'),
  },
});