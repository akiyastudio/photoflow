import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(process.cwd(), 'extensions/team-retouch/renderer'),
  base: './',
  plugins: [react()],
  build: { outDir: resolve(process.cwd(), 'artifacts/component-renderers/team-retouch'), emptyOutDir: true },
});
