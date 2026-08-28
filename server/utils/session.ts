import type { H3Event } from 'h3'

/** What the session cookie carries, which is a subset of the account row. */
export interface SessionUser {
  id: string
  email: string | null
  firstName: string
  lastName: string
  role: 'owner' | 'admin' | 'member'
  sessionVersion: number
}

/**
 * Rewrites the session cookie from a freshly saved account.
 *
 * The cookie carries the display name, the address and the session version, so changing any
 * of them on the row leaves the cookie stale until this runs. It stays in the transport layer
 * rather than in an operation because only a request has a cookie to replace: an API or MCP
 * caller changing their own password has no session, and needs none.
 *
 * Only an anonymized account has no address, and the auth middleware turns those away as
 * disabled, so a live session always has one.
 */
export async function refreshSession(event: H3Event, user: SessionUser): Promise<void> {
  await replaceUserSession(event, {
    user: {
      id: user.id,
      email: user.email!,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      sessionVersion: user.sessionVersion,
    },
    loggedInAt: new Date().toISOString(),
  })
}
