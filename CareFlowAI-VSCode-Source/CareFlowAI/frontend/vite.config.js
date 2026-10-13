import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { preserveSymlinks: true },
  server: { proxy: { '/api': 'http://127.0.0.1:4100' } },
  build: { sourcemap: true }
});
