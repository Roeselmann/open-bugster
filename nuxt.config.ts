import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2026-08-01',
  devtools: { enabled: true },
  modules: ['nuxt-auth-utils'],
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
  runtimeConfig: {
    session: {
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
      title: 'Open-Bugster · TestFlight Kanban',
      meta: [
        { name: 'description', content: 'A focused Kanban board for manual tickets and TestFlight feedback.' },
        { name: 'theme-color', content: '#0b0d10' }
      ]
    }
  },
  nitro: { preset: 'node-server' },
  typescript: { typeCheck: true, strict: true }
})
