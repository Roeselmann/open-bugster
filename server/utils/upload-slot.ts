import { randomBytes, randomUUID } from 'node:crypto'
import { actorFor, actorChannels, type Actor, type ActorChannel } from './actor'
import { findPrincipal, getDb } from './db'
import { hashToken, resolveTokenById } from './token'

/** Long enough to run one `curl`, short enough that a leaked address is soon worthless. */
export const UPLOAD_SLOT_MINUTES = 10

export interface UploadSlot {
  id: string
  ticketId: string
  principalId: string
  tokenId: string | null
  channel: ActorChannel
  filename: string | null
  expiresAt: string
}

/**
 * An address one file can be sent to, once, for one ticket.
 *
 * This is how a file an agent holds on disk reaches a ticket without its bytes passing
 * through the model's context and without the agent ever holding the API token: the token
 * stays in the MCP client's configuration, and the agent gets only this. The secret is 256
 * random bits and hashed at rest, for the same reasons a token is.
 */
export function createUploadSlot(actor: Actor, ticketId: string, filename: string | null): { secret: string; slot: UploadSlot } {
  const secret = randomBytes(32).toString('base64url')
  const now = new Date()
  const slot: UploadSlot = {
    id: randomUUID(),
    ticketId,
    principalId: actor.principalId,
    tokenId: actor.tokenId,
    channel: actor.channel,
    filename,
    expiresAt: new Date(now.getTime() + UPLOAD_SLOT_MINUTES * 60_000).toISOString()
  }
  getDb().prepare(`
    INSERT INTO upload_slots (id, secret_hash, ticket_id, principal_id, token_id, channel, filename, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slot.id, hashToken(secret), ticketId, slot.principalId, slot.tokenId, slot.channel, filename, now.toISOString(), slot.expiresAt)
  return { secret, slot }
}

/** The slot a presented secret opens, or null for one that is unknown, used or expired. */
export function findOpenUploadSlot(secret: string): UploadSlot | null {
  const row = getDb().prepare(`
    SELECT * FROM upload_slots WHERE secret_hash = ? AND used_at IS NULL AND expires_at > ?
  `).get(hashToken(secret), new Date().toISOString()) as SlotRow | undefined
  return row ? toSlot(row) : null
}

/**
 * Spends the slot. Atomic, so two uploads racing for one address cannot both get through:
 * whichever reaches the row second finds it used.
 *
 * Spent before the file is checked, not after — a rejected file costs the agent a new
 * address, which is one tool call, and an address that survives a failure is one somebody
 * can keep trying against.
 */
export function claimUploadSlot(id: string): boolean {
  return getDb().prepare('UPDATE upload_slots SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?')
    .run(new Date().toISOString(), id, new Date().toISOString()).changes > 0
}

/**
 * Who the upload is made as: whoever asked for the address, through the credential they
 * asked with. A token revoked since, or an account disabled since, leaves nobody — the
 * address dies with what issued it.
 */
export function actorForUploadSlot(slot: UploadSlot): Actor | null {
  if (slot.tokenId) return resolveTokenById(slot.tokenId, slot.channel)
  const principal = findPrincipal(slot.principalId)
  if (!principal || principal.status !== 'active' || principal.anonymizedAt) return null
  return actorFor(principal, { channel: slot.channel })
}

/** Spent and expired slots are of no use to anybody; a day keeps them around for debugging. */
export function pruneUploadSlots(hours = 24): number {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString()
  return getDb().prepare('DELETE FROM upload_slots WHERE expires_at < ?').run(cutoff).changes
}

type SlotRow = {
  id: string; secret_hash: string; ticket_id: string; principal_id: string; token_id: string | null
  channel: string; filename: string | null; created_at: string; expires_at: string; used_at: string | null
}

function toSlot(row: SlotRow): UploadSlot {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    principalId: row.principal_id,
    tokenId: row.token_id,
    channel: (actorChannels as readonly string[]).includes(row.channel) ? row.channel as ActorChannel : 'api',
    filename: row.filename,
    expiresAt: row.expires_at
  }
}
