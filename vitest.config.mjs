import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup-isolation.mjs'],
    testTimeout: 15000,
    // Vitest owns the suites in tests/ (plural). The custom process.exit-based
    // runners in test/ (singular, *.test.cjs) are NOT vitest suites — they run
    // via `node` in the npm test script. Without this, vitest's default glob
    // sweeps them up and dies with "No test suite found" + "process.exit called".
    include: ['tests/**/*.test.{js,mjs,cjs}'],
  },
});
