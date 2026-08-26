import { describe, expect, it } from 'vitest'
import { computeImportCutoff, isWithinImportWindow, titleFromFeedback } from '../server/utils/import-policy'

describe('TestFlight import policy', () => {
  const now = new Date('2026-08-24T12:00:00.000Z')

  it('uses a 90 day window for the first import', () => {
    expect(computeImportCutoff(null, now).toISOString()).toBe('2026-05-26T12:00:00.000Z')
  })

  it('uses a 24 hour overlap after a successful sync', () => {
    expect(computeImportCutoff('2026-08-20T09:30:00.000Z', now).toISOString()).toBe('2026-08-19T09:30:00.000Z')
  })

  it('rejects invalid and older dates', () => {
    const cutoff = new Date('2026-05-26T12:00:00.000Z')
    expect(isWithinImportWindow('2026-05-26T12:00:00.000Z', cutoff)).toBe(true)
    expect(isWithinImportWindow('2026-05-25T23:59:59.000Z', cutoff)).toBe(false)
    expect(isWithinImportWindow('not-a-date', cutoff)).toBe(false)
  })

  it('creates complete titles from feedback', () => {
    expect(titleFromFeedback('crash', null, 'iPhone 17 Pro')).toBe('TestFlight crash on iPhone 17 Pro')
    expect(titleFromFeedback('screenshot', '  The   button does not respond  ', null)).toBe('The button does not respond')
    expect(titleFromFeedback('screenshot', 'a'.repeat(140), null)).toBe('a'.repeat(140))
  })
})
