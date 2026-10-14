import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const page = (p) => fileURLToPath(new URL(p, import.meta.url));

// Two pages: the home page, and /urea-cycle/ (the paper and poster).
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: page('index.html'), ureaCycle: page('urea-cycle/index.html') },
    },
  },
});
