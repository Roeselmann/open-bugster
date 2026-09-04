/**
 * One sync at a time per board and provider.
 *
 * Two clicks on the sync button, or a REST call landing while the UI's is still running,
 * would otherwise race for the same issues and each report the other's as failures. The
 * lock is in-process, which is exactly the scope the server has.
 */
const running = new Set<string>()

/** Returns the release function, or null when that board's provider is already syncing. */
export function acquireSyncLock(boardId: string, provider: string): (() => void) | null {
  const key = `${boardId}:${provider}`
  if (running.has(key)) return null
  running.add(key)
  return () => { running.delete(key) }
}
