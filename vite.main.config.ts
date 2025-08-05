import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    // Some libs that can run in both Web and Node.js, such as `axios`, we need to tell Vite to build them in Node.js.
    browserField: false,
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    ssr: true,
    minify: process.env.NODE_ENV === 'production',
    outDir: 'dist/main',
    rollupOptions: {
      external: [
        'electron',
        '@hono/node-server',
        'hono',
        // Add other external dependencies as needed
      ],
    },
  },
});