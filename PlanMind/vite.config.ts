import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: { outDir: 'dist/public/PlanMind', emptyOutDir: true,
    rollupOptions: { input: 'app/main.ts', output: { entryFileNames: 'assets/app.js', assetFileNames: 'assets/app.[ext]' } } },
});
