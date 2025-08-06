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
    target: 'node18',
    minify: process.env.NODE_ENV === 'production',
    rollupOptions: {
      external: [
        'electron',
        // Only keep Electron as external - bundle everything else
      ],
    },
  },
  ssr: {
    noExternal: true, // Bundle ALL dependencies
  },
});