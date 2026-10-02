import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // raptorq ships only a "module" entry, which Node-side resolution ignores.
    alias: { raptorq: fileURLToPath(new URL('./node_modules/raptorq/raptorq.js', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 180_000,
  },
});
