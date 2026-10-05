import { defineConfig } from 'vitest/config';

// Run through `pnpm test:emulator`, which starts the Firestore and Realtime Database emulators first.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-emulator/**/*.test.ts'],
    // every file shares the same emulator data
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
