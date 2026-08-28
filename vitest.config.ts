import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The same aliases Nuxt provides at runtime. Without them, anything under `server/api`
  // is unimportable from a test, which is most of why the API layer had no coverage.
  resolve: {
    alias: {
      '~~': fileURLToPath(new URL('.', import.meta.url)),
      '@@': fileURLToPath(new URL('.', import.meta.url)),
      '~': fileURLToPath(new URL('./app', import.meta.url)),
      '@': fileURLToPath(new URL('./app', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    coverage: { reporter: ['text', 'html'] }
  }
})
