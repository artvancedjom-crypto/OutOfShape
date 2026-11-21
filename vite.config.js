import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  // Relative base: the same build works on a web server (any sub-path),
  // from the desktop shell's app:// origin, and from `vite preview`.
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});
