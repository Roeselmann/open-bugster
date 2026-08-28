/**
 * A fixed-window counter, per credential.
 *
 * This is a stability control rather than a courtesy. `better-sqlite3` is synchronous, so a
 * client in a tight loop does not merely use its share — it holds the event loop and stalls
 * every other request, including the browser session of whoever is trying to work out what is
 * going on.
 *
 * Deliberately in memory: this is a single-process, self-hosted app, and a table would mean a
 * synchronous write on the very path being protected. The cost is that the window resets when
 * the container restarts, and that it counts per process rather than per instance if anyone
 * ever runs more than one.
 */
export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  /** Unix seconds when the current window ends. */
  resetAt: number
  /** Seconds to wait, for the `Retry-After` header. */
  retryAfter: number
}

const windows = new Map<string, { count: number; startedAt: number }>()

export function rateLimitWindowMs(): number {
  return 60_000
}

export function rateLimitMax(): number {
  const configured = Number(process.env.API_RATE_LIMIT)
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 120
}

export function checkRateLimit(key: string, now = Date.now()): RateLimitResult {
  const limit = rateLimitMax()
  const windowMs = rateLimitWindowMs()
  const existing = windows.get(key)

  if (!existing || now - existing.startedAt >= windowMs) {
    windows.set(key, { count: 1, startedAt: now })
    if (windows.size > 10_000) sweep(now, windowMs)
    return { allowed: true, limit, remaining: limit - 1, resetAt: Math.ceil((now + windowMs) / 1000), retryAfter: 0 }
  }

  existing.count += 1
  const resetAtMs = existing.startedAt + windowMs
  const remaining = Math.max(0, limit - existing.count)
  return {
    allowed: existing.count <= limit,
    limit,
    remaining,
    resetAt: Math.ceil(resetAtMs / 1000),
    retryAfter: Math.max(1, Math.ceil((resetAtMs - now) / 1000))
  }
}

/** Only ever called when the map has grown large, so the cost lands on abusers. */
function sweep(now: number, windowMs: number) {
  for (const [key, entry] of windows) {
    if (now - entry.startedAt >= windowMs) windows.delete(key)
  }
}

/** Exposed for tests, which would otherwise leak counts into one another. */
export function resetRateLimits() {
  windows.clear()
}
