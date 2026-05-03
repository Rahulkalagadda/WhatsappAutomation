import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.VITE_DEV_API_TARGET || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/health': { target: API, changeOrigin: true },
      '/auth': { target: API, changeOrigin: true },
      '/messages': { target: API, changeOrigin: true },
    },
  },
  preview: {
    port: 5173,
    proxy: {
      '/health': { target: API, changeOrigin: true },
      '/auth': { target: API, changeOrigin: true },
      '/messages': { target: API, changeOrigin: true },
    },
  },
});
