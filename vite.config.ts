import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Tauri drives this dev server; the fixed port and strict mode keep the
// Rust side's devUrl honest instead of silently landing on a fallback port.
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1425,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] }
  },
  build: {
    // Vite 8 minifies with oxc; naming esbuild here now needs it installed
    // separately, so leave the default in place.
    target: 'chrome120',
    minify: true,
    sourcemap: false,
    chunkSizeWarningLimit: 700
  }
});
