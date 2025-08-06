import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    ssr: true,
    minify: process.env.NODE_ENV === 'production',
    rollupOptions: {
      external: ['electron'],
    },
  },
});