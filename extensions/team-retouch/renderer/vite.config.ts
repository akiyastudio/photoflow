import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(process.cwd(), 'extensions/team-retouch/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(process.cwd(), 'artifacts/component-renderers/team-retouch'),
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve(process.cwd(), 'extensions/team-retouch/renderer/index.html'), settings: resolve(process.cwd(), 'extensions/team-retouch/renderer/settings.html') } },
  },
});
