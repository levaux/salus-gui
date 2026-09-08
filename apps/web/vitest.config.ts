import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Deliberately NOT the SvelteKit vite config: these tests cover pure logic
 * (catalog mapping, row derivation, formatting), which needs no browser and no
 * framework. Component behaviour is verified against the mock stack by hand —
 * the single-tier decision in plan 001.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
    },
  },
});
