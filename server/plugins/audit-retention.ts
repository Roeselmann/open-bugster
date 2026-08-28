import { auditRetentionDays, pruneAudit } from '~~/server/utils/audit'
import { pruneIdempotent } from '~~/server/utils/db'
import { pruneDeliveries } from '~~/server/utils/webhook'

/**
 * Sweeps the audit log once, at startup.
 *
 * An instance that agents write to grows this table far faster than one only people touch,
 * and nothing else ever deletes from it — it is append-only by design. A container that is
 * restarted now and then is enough of a schedule for a log measured in months.
 */
export default defineNitroPlugin(() => {
  // Idempotency keys are only useful for as long as a client might still retry, so they go
  // regardless of what the audit log's retention is set to.
  const replayed = pruneIdempotent(24)
  if (replayed) console.info(`[open-bugster] pruned ${replayed} expired idempotency keys.`)

  // Delivery attempts are a diagnostic, not a record; a week is long enough to debug with.
  const attempts = pruneDeliveries(7)
  if (attempts) console.info(`[open-bugster] pruned ${attempts} old webhook delivery attempts.`)

  const days = auditRetentionDays()
  if (days <= 0) return
  const removed = pruneAudit(days)
  if (removed) console.info(`[open-bugster] pruned ${removed} audit entries older than ${days} days.`)
})
