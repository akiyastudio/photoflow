import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const pluginRoot = resolve(__dirname, '..');
const rendererRoot = resolve(pluginRoot, 'renderer');

export default defineConfig({
  root: rendererRoot,
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(pluginRoot, 'dist/ui'),
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve(rendererRoot, 'index.html'), settings: resolve(rendererRoot, 'settings.html') } },
  },
});
