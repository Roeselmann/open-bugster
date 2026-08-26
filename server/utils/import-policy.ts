const DAY = 24 * 60 * 60 * 1000

export function computeImportCutoff(lastSuccessfulSyncStartedAt: string | null, now = new Date()): Date {
  if (!lastSuccessfulSyncStartedAt) return new Date(now.getTime() - 90 * DAY)
  return new Date(new Date(lastSuccessfulSyncStartedAt).getTime() - DAY)
}

export function isWithinImportWindow(createdDate: string, cutoff: Date): boolean {
  const timestamp = Date.parse(createdDate)
  return Number.isFinite(timestamp) && timestamp >= cutoff.getTime()
}

export function titleFromFeedback(type: 'screenshot' | 'crash', comment: string | null, deviceModel: string | null): string {
  const normalized = comment?.replace(/\s+/g, ' ').trim()
  if (normalized) return normalized
  return type === 'crash' ? `TestFlight crash${deviceModel ? ` on ${deviceModel}` : ''}` : 'TestFlight screenshot feedback'
}
