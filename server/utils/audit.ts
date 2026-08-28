import { randomUUID } from 'node:crypto'
import type { Actor, ActorChannel } from './actor'
import { getDb } from './db'

/** Whether the attempt went through, was refused, or blew up. Refusals are worth keeping. */
export const auditResults = ['ok', 'denied', 'error'] as const
export type AuditResult = typeof auditResults[number]

export interface AuditEntry {
  id: string
  at: string
  boardId: string | null
  /** Null only for an attempt that failed before anybody was identified — a bad token. */
  principalId: string | null
  agentId: string | null
  tokenId: string | null
  channel: ActorChannel
  /** The operation name, e.g. `ticket.move`. */
  operation: string
  targetType: string
  targetId: string | null
  changes: Record<string, unknown>
  result: AuditResult
  ip: string | null
}

export interface AuditInput {
  actor?: Actor | null
  operation: string
  targetType: string
  targetId?: string | null
  boardId?: string | null
  changes?: Record<string, unknown>
  result?: AuditResult
  ip?: string | null
  /** Channel for an attempt with no actor to read it from — a rejected credential. */
  channel?: ActorChannel
}

/**
 * Appends one entry. Deliberately total: an audit write must never be the reason a request
 * fails, so a broken log degrades to a warning rather than taking the operation down with it.
 *
 * Two rules the callers have to keep, because this function cannot check them:
 *
 * - `changes` holds no secrets. Record that a private key was uploaded, never the PEM.
 * - `changes` holds no names or addresses. Person-valued fields are ids, so that
 *   `anonymizeUser` empties this log of identifying data without rewriting a single row.
 */
export function writeAudit(input: AuditInput): void {
  try {
    getDb().prepare(`
      INSERT INTO audit_log (id, at, board_id, principal_id, agent_id, token_id, channel, operation, target_type, target_id, changes, result, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      new Date().toISOString(),
      input.boardId ?? null,
      input.actor?.principalId ?? null,
      input.actor?.agentId ?? null,
      input.actor?.tokenId ?? null,
      input.actor?.channel ?? input.channel ?? 'web',
      input.operation,
      input.targetType,
      input.targetId ?? null,
      JSON.stringify(input.changes ?? {}),
      input.result ?? 'ok',
      input.ip ?? null
    )
  } catch (error) {
    console.warn('[open-bugster] could not write an audit entry:', (error as Error).message)
  }
}

export interface AuditFilter {
  boardId?: string | null
  principalId?: string
  operation?: string
  /** ISO timestamps, both inclusive. */
  since?: string
  until?: string
  limit?: number
  offset?: number
}

export function listAudit(filter: AuditFilter = {}): AuditEntry[] {
  const where: string[] = []
  const params: Array<string | number> = []
  if (filter.boardId !== undefined) {
    if (filter.boardId === null) where.push('board_id IS NULL')
    else { where.push('board_id = ?'); params.push(filter.boardId) }
  }
  if (filter.principalId) { where.push('principal_id = ?'); params.push(filter.principalId) }
  if (filter.operation) { where.push('operation = ?'); params.push(filter.operation) }
  if (filter.since) { where.push('at >= ?'); params.push(filter.since) }
  if (filter.until) { where.push('at <= ?'); params.push(filter.until) }

  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000)
  params.push(limit, Math.max(filter.offset ?? 0, 0))

  const rows = getDb().prepare(`
    SELECT * FROM audit_log
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY at DESC, rowid DESC
    LIMIT ? OFFSET ?
  `).all(...params) as AuditRow[]
  return rows.map(toEntry)
}

export function countAudit(): number {
  return (getDb().prepare('SELECT COUNT(*) AS total FROM audit_log').get() as { total: number }).total
}

/**
 * Drops entries older than the retention window. Called at startup: an instance an agent is
 * writing to accumulates entries much faster than one only people touch, and SQLite will
 * grow forever if nothing ever sweeps.
 *
 * `AUDIT_RETENTION_DAYS=0` keeps everything, for anyone whose compliance rules say so.
 */
export function pruneAudit(days = auditRetentionDays()): number {
  if (days <= 0) return 0
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
  return getDb().prepare('DELETE FROM audit_log WHERE at < ?').run(cutoff).changes
}

export function auditRetentionDays(): number {
  const configured = Number(process.env.AUDIT_RETENTION_DAYS)
  return Number.isFinite(configured) && configured >= 0 ? configured : 365
}

type AuditRow = {
  id: string; at: string; board_id: string | null; principal_id: string | null
  agent_id: string | null; token_id: string | null; channel: ActorChannel
  operation: string; target_type: string; target_id: string | null
  changes: string; result: AuditResult; ip: string | null
}

function toEntry(row: AuditRow): AuditEntry {
  let changes: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.changes)
    if (parsed && typeof parsed === 'object') changes = parsed as Record<string, unknown>
  } catch {
    // A malformed payload is not worth losing the entry over — the rest still tells the story.
  }
  return {
    id: row.id,
    at: row.at,
    boardId: row.board_id,
    principalId: row.principal_id,
    agentId: row.agent_id,
    tokenId: row.token_id,
    channel: row.channel,
    operation: row.operation,
    targetType: row.target_type,
    targetId: row.target_id,
    changes,
    result: row.result,
    ip: row.ip
  }
}
