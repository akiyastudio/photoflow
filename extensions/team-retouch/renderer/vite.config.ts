import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(process.cwd(), 'extensions/team-retouch/renderer'),
  base: './',
  build: { outDir: resolve(process.cwd(), 'artifacts/component-renderers/team-retouch'), emptyOutDir: true },
});
