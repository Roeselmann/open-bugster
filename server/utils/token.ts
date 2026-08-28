import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createError } from 'h3'
import type { BoardRole } from '../../shared/types/domain'
import { actorFor, type Actor, type ActorChannel } from './actor'
import { getDb, findPrincipal, type UserRecord } from './db'

/**
 * What a credential is allowed to do. A ceiling, never a grant: the reach of a token is the
 * intersection of its scopes with what its principal could already do, so a viewer's
 * `write` token still cannot write.
 */
export const tokenScopes = ['read', 'write', 'admin'] as const
export type TokenScope = typeof tokenScopes[number]

/** The board role each scope tops out at. */
const scopeCeiling: Record<TokenScope, BoardRole> = { read: 'viewer', write: 'editor', admin: 'admin' }
const roleRank: Record<BoardRole, number> = { viewer: 0, editor: 1, admin: 2 }

/** The most a set of scopes permits, or null for a set that permits nothing. */
export function ceilingFor(scopes: readonly TokenScope[]): BoardRole | null {
  let best: BoardRole | null = null
  for (const scope of scopes) {
    const role = scopeCeiling[scope]
    if (role && (!best || roleRank[role] > roleRank[best])) best = role
  }
  return best
}

export const TOKEN_PREFIX = 'bgs'

/**
 * A token is hashed with SHA-256 rather than the scrypt used for passwords.
 *
 * That is deliberate and not a shortcut. A slow KDF exists to make guessing a *low-entropy*
 * human-chosen secret expensive; these are 256 random bits, where guessing is already out of
 * reach. Running scrypt on every API request would only tax the server — and this is the hot
 * path for exactly the automated callers most likely to be chatty. It also matches how invite
 * tokens are already stored.
 */
export function hashToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export interface MintedToken {
  id: string
  /** Shown once and never stored. */
  token: string
}

export interface TokenInput {
  principalId: string
  name: string
  agentLabel?: string | null
  scopes: readonly TokenScope[]
  boardId?: string | null
  expiresAt?: string | null
  createdBy?: string | null
}

export function createApiToken(input: TokenInput): MintedToken {
  const id = randomUUID()
  const secret = randomBytes(32).toString('base64url')
  getDb().prepare(`
    INSERT INTO api_tokens (id, principal_id, name, agent_label, token_hash, scopes, board_id, created_at, created_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.principalId, input.name, input.agentLabel ?? null, hashToken(secret),
    JSON.stringify([...input.scopes]), input.boardId ?? null,
    new Date().toISOString(), input.createdBy ?? null, input.expiresAt ?? null
  )
  return { id, token: `${TOKEN_PREFIX}_${id}_${secret}` }
}

export interface ApiTokenRecord {
  id: string
  principalId: string
  name: string
  agentLabel: string | null
  scopes: TokenScope[]
  boardId: string | null
  createdAt: string
  createdBy: string | null
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
}

export function listApiTokens(principalId?: string): ApiTokenRecord[] {
  const rows = principalId
    ? getDb().prepare('SELECT * FROM api_tokens WHERE principal_id = ? ORDER BY created_at DESC').all(principalId)
    : getDb().prepare('SELECT * FROM api_tokens ORDER BY created_at DESC').all()
  return (rows as TokenRow[]).map(toRecord)
}

export function findApiToken(id: string): ApiTokenRecord | null {
  const row = getDb().prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as TokenRow | undefined
  return row ? toRecord(row) : null
}

export function revokeApiToken(id: string): boolean {
  return getDb().prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), id).changes > 0
}

export function tokenExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  const timestamp = Date.parse(expiresAt)
  return !Number.isFinite(timestamp) || timestamp <= Date.now()
}

/**
 * Turns a presented token into an actor, or into nothing.
 *
 * Every reason to refuse returns null rather than saying which one applied: whether a token
 * is unknown, revoked, expired, or belongs to a disabled account is not something the holder
 * of a bad token gets to learn.
 *
 * A disabled or anonymized principal invalidates its live tokens here, without any of them
 * having to be revoked one by one.
 */
export function resolveToken(raw: string | null | undefined, channel: ActorChannel): Actor | null {
  if (!raw) return null
  // The secret is base64url and may itself contain underscores, so this splits on the two
  // separators it knows rather than on every underscore in the string.
  const match = new RegExp(`^${TOKEN_PREFIX}_([0-9a-fA-F-]{36})_(.+)$`).exec(raw.trim())
  if (!match) return null
  const [, id, secret] = match as unknown as [string, string, string]

  const row = getDb().prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as TokenRow | undefined
  if (!row) return null

  const expected = Buffer.from(row.token_hash, 'hex')
  const actual = Buffer.from(hashToken(secret), 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null

  if (row.revoked_at || tokenExpired(row.expires_at)) return null

  const principal = findPrincipal(row.principal_id)
  if (!principal || principal.status !== 'active' || principal.anonymizedAt) return null

  const scopes = parseScopes(row.scopes)
  if (!scopes.length) return null

  getDb().prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id)

  return actorFor(principal, {
    channel,
    // The label is provenance the history shows; it grants nothing.
    agentId: row.agent_label,
    tokenId: row.id,
    scopes,
    boardScope: row.board_id
  })
}

/** The account a service identity acts as, refused if it is not one. */
export function requireServicePrincipal(principalId: string): UserRecord {
  const principal = findPrincipal(principalId)
  if (!principal) throw createError({ statusCode: 404, statusMessage: 'Account not found.' })
  return principal
}

type TokenRow = {
  id: string; principal_id: string; name: string; agent_label: string | null
  token_hash: string; scopes: string; board_id: string | null
  created_at: string; created_by: string | null
  expires_at: string | null; last_used_at: string | null; revoked_at: string | null
}

function parseScopes(value: string): TokenScope[] {
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((scope): scope is TokenScope => (tokenScopes as readonly string[]).includes(scope))
  } catch {
    return []
  }
}

function toRecord(row: TokenRow): ApiTokenRecord {
  return {
    id: row.id,
    principalId: row.principal_id,
    name: row.name,
    agentLabel: row.agent_label,
    scopes: parseScopes(row.scopes),
    boardId: row.board_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at
  }
}
