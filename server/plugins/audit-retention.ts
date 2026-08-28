import { auditRetentionDays, pruneAudit } from '~~/server/utils/audit'

/**
 * Sweeps the audit log once, at startup.
 *
 * An instance that agents write to grows this table far faster than one only people touch,
 * and nothing else ever deletes from it — it is append-only by design. A container that is
 * restarted now and then is enough of a schedule for a log measured in months.
 */
export default defineNitroPlugin(() => {
  const days = auditRetentionDays()
  if (days <= 0) return
  const removed = pruneAudit(days)
  if (removed) console.info(`[open-bugster] pruned ${removed} audit entries older than ${days} days.`)
})
