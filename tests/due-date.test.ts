import { describe, expect, it } from 'vitest'
import { boardToday, daysUntil, dueDescription, dueLevel } from '../shared/utils/due-date'

const defaults = { warningDays: 7, alertDays: 0 }

describe('dueLevel', () => {
  it('turns red on the day itself and stays red once overdue', () => {
    expect(dueLevel('2026-11-02', '2026-11-02', defaults)).toBe('alert')
    expect(dueLevel('2026-10-28', '2026-11-02', defaults)).toBe('alert')
  })

  it('turns orange within the warning window and leaves later dates alone', () => {
    expect(dueLevel('2026-11-03', '2026-11-02', defaults)).toBe('warning')
    expect(dueLevel('2026-11-09', '2026-11-02', defaults)).toBe('warning')
    expect(dueLevel('2026-11-10', '2026-11-02', defaults)).toBe('none')
  })

  it('follows the board’s own lead times, with red winning where they overlap', () => {
    expect(dueLevel('2026-11-04', '2026-11-02', { warningDays: 7, alertDays: 2 })).toBe('alert')
    expect(dueLevel('2026-11-05', '2026-11-02', { warningDays: 7, alertDays: 2 })).toBe('warning')
    expect(dueLevel('2026-11-05', '2026-11-02', { warningDays: 2, alertDays: 5 })).toBe('alert')
  })

  it('says nothing without a due date', () => {
    expect(dueLevel(null, '2026-11-02', defaults)).toBe('none')
    expect(dueLevel('not a date', '2026-11-02', defaults)).toBe('none')
  })
})

describe('daysUntil', () => {
  it('counts calendar days across a daylight saving change', () => {
    expect(daysUntil('2026-10-26', '2026-10-24')).toBe(2)
    expect(daysUntil('2026-11-01', '2026-11-02')).toBe(-1)
  })
})

describe('boardToday', () => {
  it('reads the date in Berlin, not UTC', () => {
    expect(boardToday(new Date('2026-11-02T23:30:00Z'))).toBe('2026-11-03')
    expect(boardToday(new Date('2026-11-02T10:00:00Z'))).toBe('2026-11-02')
  })
})

describe('dueDescription', () => {
  it('says when in words a person reads at a glance', () => {
    expect(dueDescription('2026-11-02', '2026-11-02')).toBe('Due today')
    expect(dueDescription('2026-11-03', '2026-11-02')).toBe('Due tomorrow')
    expect(dueDescription('2026-11-06', '2026-11-02')).toBe('Due in 4 days')
    expect(dueDescription('2026-11-01', '2026-11-02')).toBe('Overdue by 1 day')
    expect(dueDescription('2026-10-30', '2026-11-02')).toBe('Overdue by 3 days')
  })
})
