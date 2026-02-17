import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:4800',
        ws: true,
      },
      '/health': 'http://127.0.0.1:4800',
      '/pair': 'http://127.0.0.1:4800',
      '/sessions': 'http://127.0.0.1:4800',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-tldraw': ['tldraw'],
        },
      },
    },
  },
});
