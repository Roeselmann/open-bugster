import { ensureRuntimeSecrets } from '~~/server/utils/runtime-secrets'

/**
 * Runs before anything can seal a session cookie or touch the secret box (the `00-`
 * prefix keeps it first in the plugin order). Whatever `ensureRuntimeSecrets` resolved
 * is pushed into the environment, because that is where both consumers look: the secret
 * box reads BUGSTER_SECRET_KEY directly, and Nitro rebuilds the per-request runtime
 * config from the environment on every request, which is how NUXT_SESSION_PASSWORD
 * reaches nuxt-auth-utils. (The shared config object cannot be patched instead — it is
 * frozen in production builds.)
 */
export default defineNitroPlugin(() => {
  const secrets = ensureRuntimeSecrets()
  process.env.NUXT_SESSION_PASSWORD = secrets.sessionPassword
  if (secrets.secretKey) process.env.BUGSTER_SECRET_KEY = secrets.secretKey
  if (secrets.generated.length > 0) {
    console.info(`[open-bugster] Generated ${secrets.generated.join(' and ')} and stored ${secrets.generated.length > 1 ? 'them' : 'it'} in ${secrets.filePath}. Set the variable${secrets.generated.length > 1 ? 's' : ''} in .env only if you want to manage ${secrets.generated.length > 1 ? 'these secrets' : 'this secret'} yourself.`)
  }
})
