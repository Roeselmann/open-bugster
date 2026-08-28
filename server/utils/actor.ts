import { createError, type H3Event } from 'h3'
import type { UserRecord } from './db'

/** How a call reached the server. Recorded on everything an actor changes. */
export const actorChannels = ['web', 'api', 'mcp'] as const
export type ActorChannel = typeof actorChannels[number]

declare module 'h3' {
  interface H3EventContext {
    /** The signed-in account, resolved fresh from the database by the auth middleware. */
    account?: UserRecord
  }
}

/**
 * Who is behind a call, split in two.
 *
 * `principalId` is who is *responsible*: an account today, a service identity once those
 * exist. Every permission check reads this and nothing else, which is what keeps an agent
 * from ever doing more than the principal it acts for.
 *
 * `agentId` is what *performed* it — "Claude Desktop", "n8n prod". It is provenance and
 * never permission. A person clicking in the browser leaves it null.
 *
 * The pair is the same distinction git draws between an author and a committer: one name
 * answers for the change, the other records how it arrived.
 */
export interface Actor {
  principalId: string
  agentId: string | null
  /** Which credential, so a single leaked token can be revoked without touching the rest. */
  tokenId: string | null
  channel: ActorChannel
  /** The principal's own record, resolved once so a permission check needs no second lookup. */
  principal: UserRecord
}

/**
 * The actor behind a signed-in browser request.
 *
 * The auth middleware has already resolved the account fresh from the database and rejected
 * a stale session, so reaching here without one means the route was called outside that
 * middleware — a mistake worth surfacing as a 401 rather than a crash.
 */
export function sessionActor(event: H3Event): Actor {
  const account = event.context.account
  if (!account) throw createError({ statusCode: 401, statusMessage: 'Sign in to continue.' })
  return actorFor(account, { channel: 'web' })
}

/**
 * An actor for work with no request behind it: a scheduled import, a migration backfill.
 * Named rather than null so the history says who a change is attributed to.
 */
export function actorFor(principal: UserRecord, options: { channel?: ActorChannel; agentId?: string | null; tokenId?: string | null } = {}): Actor {
  return {
    principalId: principal.id,
    agentId: options.agentId ?? null,
    tokenId: options.tokenId ?? null,
    channel: options.channel ?? 'web',
    principal
  }
}

/** How an actor reads in a log line: `u_12ab via n8n-prod`. */
export function describeActor(actor: Actor | null): string {
  if (!actor) return 'system'
  return actor.agentId ? `${actor.principalId} via ${actor.agentId}` : actor.principalId
}
