import { findUser } from '~~/server/utils/db'

/**
 * Re-reads the account on every session fetch, so disabling someone or changing a password
 * takes effect on sessions that are already open. The API middleware cannot do this alone:
 * `/api/_auth/session` is exempt from it and would keep serving the cookie's stale copy.
 */
export default defineNitroPlugin(() => {
  sessionHooks.hook('fetch', async (session, event) => {
    const current = session.user
    if (!current) return
    const account = findUser(current.id)
    if (!account || account.status !== 'active' || account.sessionVersion !== current.sessionVersion) {
      await clearUserSession(event)
      throw createError({ statusCode: 401, statusMessage: 'This session is no longer valid.' })
    }
    session.user = {
      id: account.id,
      email: account.email,
      firstName: account.firstName,
      lastName: account.lastName,
      role: account.role,
      sessionVersion: account.sessionVersion,
    }
  })
})
