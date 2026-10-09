import { defineConfig } from 'vitest/config';

// Integration tests talk to a real Kubo node; see tests/integration/README.md.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
