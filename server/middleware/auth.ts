import { findUser } from '~~/server/utils/db'

/** Endpoints that have to work before anyone is signed in. */
const publicPaths = ['/api/auth/login', '/api/_auth/session']

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  if (!path.startsWith('/api/')) return
  if (publicPaths.includes(path) || path.startsWith('/api/invite/')) return
  const session = await requireUserSession(event)
  const account = findUser(session.user.id)
  if (!account || account.status !== 'active' || account.sessionVersion !== session.user.sessionVersion) {
    await clearUserSession(event)
    throw createError({ statusCode: 401, statusMessage: 'This session is no longer valid.' })
  }
  event.context.account = account
})
