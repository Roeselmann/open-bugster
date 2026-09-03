import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { getDb } from './db'
import { WEBHOOK_DELIVERY } from '../../shared/utils/webhook-catalogue'

/**
 * The events a board can send.
 *
 * These are the shapes worth reacting to, which is not the same as the list of operations —
 * `ticket.update` fires one event whatever field moved, because a workflow that cares which
 * field can read the payload.
 */
export const webhookEvents = [
  'ticket.created', 'ticket.updated', 'ticket.moved', 'ticket.transferred', 'ticket.archived', 'ticket.restored',
  'comment.added', 'import.completed'
] as const
export type WebhookEvent = typeof webhookEvents[number]

/** Which operation produces which event. Anything absent sends nothing. */
export const eventForOperation: Record<string, WebhookEvent> = {
  'ticket.create': 'ticket.created',
  'ticket.update': 'ticket.updated',
  'ticket.move': 'ticket.moved',
  'ticket.transfer': 'ticket.transferred',
  'ticket.archive': 'ticket.archived',
  'ticket.restore': 'ticket.restored',
  'comment.add': 'comment.added',
  'import.run': 'import.completed'
}

export interface WebhookRecord {
  id: string
  boardId: string
  url: string
  events: WebhookEvent[]
  enabled: boolean
  description: string
  createdAt: string
  createdBy: string | null
  disabledAt: string | null
  consecutiveFailures: number
  lastDeliveryAt: string | null
}

export interface DeliveryRecord {
  id: string
  webhookId: string
  event: string
  at: string
  attempt: number
  status: number | null
  error: string | null
  durationMs: number | null
}

export class WebhookUrlError extends Error {}

/**
 * Screens a destination.
 *
 * The awkward part: the whole point of this feature is posting to an n8n or a CI runner that
 * is very often on the same Docker network or LAN, so refusing every private address would
 * break the main use case to prevent an attack that requires an already-trusted board admin.
 *
 * So private ranges are allowed by default and can be switched off with
 * `WEBHOOK_ALLOW_PRIVATE=false`. Link-local is refused either way: `169.254.169.254` is the
 * cloud metadata endpoint on every major provider, it hands out credentials to anything that
 * asks, and no webhook has ever legitimately pointed at it.
 */
export async function assertDeliverable(rawUrl: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new WebhookUrlError('That is not a valid URL.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WebhookUrlError('The URL has to be http or https.')
  }
  if (url.username || url.password) {
    throw new WebhookUrlError('Credentials in the URL are not accepted; use the signature instead.')
  }

  const addresses = await resolveAll(url.hostname)
  if (!addresses.length) throw new WebhookUrlError('That host could not be resolved.')

  for (const address of addresses) {
    if (isLinkLocal(address)) {
      throw new WebhookUrlError('Link-local addresses are never delivered to; that range holds the cloud metadata service.')
    }
    if (!allowPrivateTargets() && isPrivate(address)) {
      throw new WebhookUrlError('This instance only delivers to public addresses. Set WEBHOOK_ALLOW_PRIVATE=true to allow internal ones.')
    }
  }
  return url
}

export function allowPrivateTargets(): boolean {
  return process.env.WEBHOOK_ALLOW_PRIVATE !== 'false'
}

async function resolveAll(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname]
  try {
    const results = await lookup(hostname, { all: true })
    return results.map(entry => entry.address)
  } catch {
    return []
  }
}

function isLinkLocal(address: string): boolean {
  return address.startsWith('169.254.') || address.toLowerCase().startsWith('fe80:') || address.toLowerCase().startsWith('fd00:ec2:')
}

function isPrivate(address: string): boolean {
  if (address === '::1' || address.startsWith('127.')) return true
  if (address.startsWith('10.') || address.startsWith('192.168.')) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return true
  // Unique local addresses.
  return /^f[cd]/i.test(address)
}

/* ── storage ────────────────────────────────────────────────────────────── */

type WebhookRow = {
  id: string; board_id: string; url: string; secret: string; events: string
  enabled: number; description: string; created_at: string; created_by: string | null
  disabled_at: string | null; consecutive_failures: number; last_delivery_at: string | null
}

function toWebhook(row: WebhookRow): WebhookRecord {
  let events: WebhookEvent[] = []
  try {
    const parsed = JSON.parse(row.events)
    if (Array.isArray(parsed)) events = parsed.filter((event): event is WebhookEvent => (webhookEvents as readonly string[]).includes(event))
  } catch { /* a malformed list means no events, not a broken board */ }
  return {
    id: row.id,
    boardId: row.board_id,
    url: row.url,
    events,
    enabled: Boolean(row.enabled),
    description: row.description,
    createdAt: row.created_at,
    createdBy: row.created_by,
    disabledAt: row.disabled_at,
    consecutiveFailures: row.consecutive_failures,
    lastDeliveryAt: row.last_delivery_at
  }
}

/** The secret never leaves through a listing; it is shown once, when the webhook is made. */
export function listWebhooks(boardId: string): WebhookRecord[] {
  const rows = getDb().prepare('SELECT * FROM webhooks WHERE board_id = ? ORDER BY created_at DESC').all(boardId) as WebhookRow[]
  return rows.map(toWebhook)
}

export function findWebhook(id: string): WebhookRecord | null {
  const row = getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow | undefined
  return row ? toWebhook(row) : null
}

export function createWebhook(input: { boardId: string; url: string; events: WebhookEvent[]; description?: string; createdBy?: string | null }): { webhook: WebhookRecord; secret: string } {
  const id = randomUUID()
  const secret = `whsec_${randomBytes(32).toString('base64url')}`
  getDb().prepare(`
    INSERT INTO webhooks (id, board_id, url, secret, events, description, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.boardId, input.url, secret, JSON.stringify(input.events), input.description ?? '', new Date().toISOString(), input.createdBy ?? null)
  return { webhook: findWebhook(id)!, secret }
}

export function updateWebhook(id: string, input: { url?: string; events?: WebhookEvent[]; enabled?: boolean; description?: string }): WebhookRecord | null {
  const existing = findWebhook(id)
  if (!existing) return null
  getDb().prepare(`
    UPDATE webhooks SET url = ?, events = ?, enabled = ?, description = ?,
      disabled_at = CASE WHEN ? = 1 THEN NULL ELSE disabled_at END,
      consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures END
    WHERE id = ?
  `).run(
    input.url ?? existing.url,
    JSON.stringify(input.events ?? existing.events),
    input.enabled === undefined ? (existing.enabled ? 1 : 0) : (input.enabled ? 1 : 0),
    input.description ?? existing.description,
    // Re-enabling clears the failure count, so a fixed endpoint starts from a clean slate.
    input.enabled === true ? 1 : 0,
    input.enabled === true ? 1 : 0,
    id
  )
  return findWebhook(id)
}

export function deleteWebhook(id: string): boolean {
  return getDb().prepare('DELETE FROM webhooks WHERE id = ?').run(id).changes > 0
}

export function listDeliveries(webhookId: string, limit = 50): DeliveryRecord[] {
  const rows = getDb().prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY at DESC LIMIT ?')
    .all(webhookId, Math.min(Math.max(limit, 1), 200)) as Array<Record<string, unknown>>
  return rows.map(row => ({
    id: row.id as string,
    webhookId: row.webhook_id as string,
    event: row.event as string,
    at: row.at as string,
    attempt: row.attempt as number,
    status: (row.status as number | null) ?? null,
    error: (row.error as string | null) ?? null,
    durationMs: (row.duration_ms as number | null) ?? null
  }))
}

/* ── signing ────────────────────────────────────────────────────────────── */

/**
 * `t=<unix>,v1=<hex>` over `<timestamp>.<body>`.
 *
 * The timestamp is inside the signed material so a captured delivery cannot be replayed later
 * against a receiver that checks it — which is why the header carries it rather than leaving
 * the receiver to trust a `Date`.
 */
export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${digest}`
}

/** For a receiver, and for the tests: constant-time, and it re-derives rather than trusting. */
export function verifySignature(secret: string, body: string, header: string, toleranceSeconds = WEBHOOK_DELIVERY.signatureToleranceSeconds): boolean {
  const parts = Object.fromEntries(header.split(',').map(piece => piece.split('=') as [string, string]))
  const timestamp = Number(parts.t)
  if (!Number.isFinite(timestamp) || !parts.v1) return false
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > toleranceSeconds) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'), 'hex')
  const actual = Buffer.from(parts.v1, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/* ── delivery ───────────────────────────────────────────────────────────── */

// Shared with the settings page, which prints these as the rules a receiver has to live with.
const MAX_ATTEMPTS = WEBHOOK_DELIVERY.maxAttempts
const FAILURES_BEFORE_DISABLING = WEBHOOK_DELIVERY.failuresBeforeDisabling

/**
 * The backoff step, squared per attempt: 1s, 4s, 9s, 16s by default — long enough to ride out
 * a receiver restarting, short enough that a workflow is not left waiting for minutes.
 *
 * Configurable mostly so a test can turn it down. A fixed constant here would mean every test
 * of the retry path costs the real backoff in wall-clock time, which is how retry logic ends
 * up untested.
 */
function retryBaseMs(): number {
  const configured = Number(process.env.WEBHOOK_RETRY_BASE_MS)
  return Number.isFinite(configured) && configured >= 0 ? configured : WEBHOOK_DELIVERY.retryBaseSeconds * 1000
}

export interface WebhookPayload {
  event: WebhookEvent
  at: string
  boardId: string
  actor: { principalId: string | null; agentId: string | null; channel: string }
  data: unknown
}

/**
 * Sends one event to every webhook on the board that asked for it.
 *
 * Fire and forget by design: a slow or dead receiver must not be able to hold up the request
 * that produced the event. Nothing here is awaited by the caller, and every failure path ends
 * in a recorded delivery rather than a thrown error.
 */
export function dispatch(boardId: string, event: WebhookEvent, payload: Omit<WebhookPayload, 'event' | 'at' | 'boardId'>): void {
  let hooks: WebhookRecord[]
  try {
    hooks = listWebhooks(boardId).filter(hook => hook.enabled && hook.events.includes(event))
  } catch {
    return
  }
  if (!hooks.length) return

  const body = JSON.stringify({ event, at: new Date().toISOString(), boardId, ...payload } satisfies WebhookPayload)
  for (const hook of hooks) void deliver(hook.id, event, body, 1)
}

async function deliver(webhookId: string, event: WebhookEvent, body: string, attempt: number): Promise<void> {
  const hook = getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(webhookId) as WebhookRow | undefined
  if (!hook || !hook.enabled) return

  const started = Date.now()
  let status: number | null = null
  let error: string | null = null

  try {
    await assertDeliverable(hook.url)
    const response = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Open-Bugster-Webhook/1',
        'X-Bugster-Event': event,
        'X-Bugster-Delivery': randomUUID(),
        'X-Bugster-Signature': signPayload(hook.secret, body)
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_DELIVERY.requestTimeoutSeconds * 1000)
    })
    status = response.status
    if (!response.ok) error = `HTTP ${response.status}`
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
  }

  record(webhookId, event, attempt, status, error, Date.now() - started)

  if (!error) {
    getDb().prepare("UPDATE webhooks SET consecutive_failures = 0, last_delivery_at = ? WHERE id = ?")
      .run(new Date().toISOString(), webhookId)
    return
  }

  if (attempt < MAX_ATTEMPTS) {
    const delay = attempt * attempt * retryBaseMs()
    setTimeout(() => void deliver(webhookId, event, body, attempt + 1), delay).unref?.()
    return
  }

  const failures = (hook.consecutive_failures ?? 0) + 1
  const exhausted = failures >= FAILURES_BEFORE_DISABLING
  getDb().prepare(`
    UPDATE webhooks SET consecutive_failures = ?, last_delivery_at = ?, enabled = ?, disabled_at = ?
    WHERE id = ?
  `).run(
    failures, new Date().toISOString(),
    exhausted ? 0 : hook.enabled,
    exhausted ? new Date().toISOString() : hook.disabled_at,
    webhookId
  )
  if (exhausted) {
    console.warn(`[open-bugster] webhook ${webhookId} disabled after ${failures} failed events.`)
  }
}

function record(webhookId: string, event: string, attempt: number, status: number | null, error: string | null, durationMs: number) {
  try {
    getDb().prepare(`
      INSERT INTO webhook_deliveries (id, webhook_id, event, at, attempt, status, error, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), webhookId, event, new Date().toISOString(), attempt, status, error?.slice(0, 500) ?? null, durationMs)
  } catch {
    // A delivery log that cannot be written is not worth failing a delivery over.
  }
}

/** Deliveries are a diagnostic, not a record; they are pruned like the idempotency keys. */
export function pruneDeliveries(days = WEBHOOK_DELIVERY.deliveryLogDays): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
  return getDb().prepare('DELETE FROM webhook_deliveries WHERE at < ?').run(cutoff).changes
}

/** Exposed so `deliver` can be exercised directly in a test. */
export const __internals = { deliver, retryBaseMs, MAX_ATTEMPTS, FAILURES_BEFORE_DISABLING }
