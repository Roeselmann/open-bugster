import { findUser } from '~~/server/utils/db'
import { actorFor } from '~~/server/utils/actor'
import { resolveToken } from '~~/server/utils/token'
import { writeAudit } from '~~/server/utils/audit'

/** Endpoints that have to work before anyone is signed in. */
const publicPaths = ['/api/auth/login', '/api/_auth/session']

/**
 * The surfaces a bearer token may be presented on.
 *
 * The internal `/api/**` routes stay cookie-only on purpose: they are the UI's own API, free
 * to change shape at any time, and a leaked token should not be able to ride them.
 */
function acceptsBearer(path: string): boolean {
  return path.startsWith('/api/v1/') || path === '/mcp' || path.startsWith('/mcp/')
}

/**
 * The two documentation endpoints, which take either credential.
 *
 * A browser reading the reference has a session cookie and no token; a generator fetching the
 * spec has a token and no cookie. Both are signed-in callers either way — the document is not
 * public, because the endpoint list is a map of the instance.
 */
const eitherCredential = ['/api/v1/openapi.json', '/api/v1/docs']

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  const bearerSurface = acceptsBearer(path)
  if (!path.startsWith('/api/') && !bearerSurface) return
  if (publicPaths.includes(path) || path.startsWith('/api/invite/')) return

  if (bearerSurface) {
    const header = getRequestHeader(event, 'authorization') || ''
    if (eitherCredential.includes(path) && !header) {
      // Fall through to the session check below rather than demanding a token.
      const session = await requireUserSession(event)
      const account = findUser(session.user.id)
      if (!account || account.status !== 'active') throw createError({ statusCode: 401, statusMessage: 'This session is no longer valid.' })
      event.context.account = account
      event.context.actor = actorFor(account, { channel: 'web' })
      return
    }
    const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
    const actor = resolveToken(presented, path.startsWith('/mcp') ? 'mcp' : 'api')
    if (!actor) {
      // Worth an entry even though nobody was identified: a run of these is the shape of
      // somebody working through a list of guesses, and it leaves no other trace.
      writeAudit({
        operation: 'auth.token',
        targetType: 'token',
        result: 'denied',
        channel: path.startsWith('/mcp') ? 'mcp' : 'api',
        ip: getRequestIP(event, { xForwardedFor: true }) ?? null
      })
      throw createError({ statusCode: 401, statusMessage: 'A valid API token is required.' })
    }
    event.context.account = actor.principal
    event.context.actor = actor
    return
  }

  const session = await requireUserSession(event)
  const account = findUser(session.user.id)
  if (!account || account.status !== 'active' || account.sessionVersion !== session.user.sessionVersion) {
    await clearUserSession(event)
    throw createError({ statusCode: 401, statusMessage: 'This session is no longer valid.' })
  }
  event.context.account = account
  event.context.actor = actorFor(account, { channel: 'web' })
})
