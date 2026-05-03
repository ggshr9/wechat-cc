import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/daemon/__e2e__/**/*.e2e.test.ts'],
    singleFork: true,
    testTimeout: 10_000,
    hookTimeout: 15_000,
    sequence: { concurrent: false },
  },
})
