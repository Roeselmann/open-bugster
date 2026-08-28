import { createHash, randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Only the hash is stored, so a copy of the database does not hand out working invites. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createInviteToken() {
  const token = randomBytes(32).toString('base64url')
  return {
    token,
    hash: hashInviteToken(token),
    expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
  }
}

export function inviteExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return true
  const timestamp = Date.parse(expiresAt)
  return !Number.isFinite(timestamp) || timestamp < Date.now()
}

/**
 * The link an administrator copies. There is no mail delivery here, so it is built from
 * the address the browser actually reached — behind a proxy that is the public one.
 */
export function inviteUrl(event: H3Event, token: string): string {
  return new URL(`/invite/${token}`, getRequestURL(event).origin).toString()
}
