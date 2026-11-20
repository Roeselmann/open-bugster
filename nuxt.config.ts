import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2026-08-01',
  // A second dev server in the same checkout (the scratch instance) builds elsewhere: sharing
  // `.nuxt` lets one server's rebuild overwrite the other's, which then runs stale code.
  ...(process.env.NUXT_BUILD_DIR ? { buildDir: process.env.NUXT_BUILD_DIR } : {}),
  devtools: { enabled: true },
  modules: ['nuxt-auth-utils'],
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
  runtimeConfig: {
    session: {
      // Cookies ignore the port, so two instances on localhost would sign each other out.
      ...(process.env.NUXT_SESSION_NAME ? { name: process.env.NUXT_SESSION_NAME } : {}),
      password: process.env.NUXT_SESSION_PASSWORD || '',
      maxAge: 60 * 60 * 24 * 7,
      cookie: {
        sameSite: 'lax' as const,
        secure: process.env.NUXT_SESSION_COOKIE_SECURE === 'true'
      }
    },
    public: {}
  },
  app: {
    head: {
      title: 'Open-Bugster',
      meta: [
        { name: 'description', content: 'A self-hosted planning and production board for teams and their AI agents.' },
        { name: 'theme-color', content: '#0b0d10' }
      ]
    }
  },
  nitro: { preset: 'node-server' },
  typescript: { typeCheck: true, strict: true }
})
