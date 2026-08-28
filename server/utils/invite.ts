import { createError } from 'h3'
import { createHash, randomBytes } from 'node:crypto'
import { findUserByInviteToken, type UserRecord } from './db'

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
 *
 * The origin comes from the request and never from a caller's input: an origin somebody
 * could supply would make this a way to mint a valid-looking link pointing anywhere.
 */
export function inviteUrl(origin: string, token: string): string {
  return new URL(`/invite/${token}`, origin).toString()
}

/**
 * The account behind a link, for both purposes it serves: finishing a new account and
 * resetting a forgotten password. A disabled account reads as an invalid link rather than
 * as a disabled one — the holder of a link is not necessarily the person it was meant for,
 * and letting a password be set here would silently hand the account back.
 */
export function accountForInviteToken(token: string): UserRecord {
  const account = findUserByInviteToken(hashInviteToken(token))
  if (!account || account.status === 'disabled' || inviteExpired(account.inviteExpiresAt)) {
    throw createError({ statusCode: 404, statusMessage: 'This link is no longer valid. Ask an administrator for a new one.' })
  }
  return account
}

/** A link for an account that never signed in reads as a welcome; every other one as a reset. */
export function invitePurpose(account: UserRecord): 'invite' | 'reset' {
  return account.status === 'invited' ? 'invite' : 'reset'
}
