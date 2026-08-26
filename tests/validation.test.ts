import { describe, expect, it } from 'vitest'
import { importedTicketUpdateSchema, ticketCreateSchema, ticketMoveSchema, ticketUpdateSchema } from '../server/utils/validation'

describe('ticket validation', () => {
  it('normalizes a valid manual ticket', () => {
    const result = ticketCreateSchema.parse({ title: '  Fix login  ', buildNumber: ' 42 ', labels: ['Auth'] })
    expect(result).toEqual({ title: 'Fix login', description: '', comment: '', priority: 'medium', buildNumber: '42', labels: ['Auth'], todos: [] })
  })

  it('rejects empty titles and invalid board moves', () => {
    expect(ticketCreateSchema.safeParse({ title: '   ' }).success).toBe(false)
    expect(ticketMoveSchema.safeParse({ status: 'review', index: 0 }).success).toBe(false)
    expect(ticketMoveSchema.safeParse({ status: 'done', index: -1 }).success).toBe(false)
  })

  it('accepts the question lane', () => {
    expect(ticketMoveSchema.parse({ status: 'question', index: 0 })).toEqual({ status: 'question', index: 0 })
  })

  it('accepts the import lane', () => {
    expect(ticketMoveSchema.parse({ status: 'import', index: 0 })).toEqual({ status: 'import', index: 0 })
  })

  it('normalizes optional category names', () => {
    expect(ticketCreateSchema.parse({ title: 'Ticket', categoryName: '  Frontend  ' }).categoryName).toBe('Frontend')
    expect(ticketCreateSchema.parse({ title: 'Ticket', categoryName: null }).categoryName).toBeNull()
    expect(ticketCreateSchema.safeParse({ title: 'Ticket', categoryName: 'x'.repeat(31) }).success).toBe(false)
  })

  it('validates and normalizes ticket todos', () => {
    expect(ticketCreateSchema.parse({
      title: 'Ticket',
      todos: [{ text: '  Reproduce the issue  ', completed: false }]
    }).todos).toEqual([{ text: 'Reproduce the issue', completed: false }])
    expect(ticketCreateSchema.safeParse({ title: 'Ticket', todos: [{ text: '   ', completed: false }] }).success).toBe(false)
    expect(ticketCreateSchema.safeParse({ title: 'Ticket', todos: [{ text: 'x'.repeat(501), completed: false }] }).success).toBe(false)
    expect(ticketCreateSchema.safeParse({ title: 'Ticket', todos: Array.from({ length: 101 }, (_, index) => ({ text: `To-do ${index}`, completed: false })) }).success).toBe(false)
    expect(ticketUpdateSchema.parse({ comment: 'Only change the comment' })).toEqual({ comment: 'Only change the comment' })
  })

  it('allows all regular fields of imported tickets to be updated', () => {
    const update = importedTicketUpdateSchema.parse({
      title: '  Complete title  ', description: 'Details', comment: 'Internal note', priority: 'urgent',
      dueDate: '2026-08-30', labels: ['TestFlight', 'Regression'], categoryName: ' iOS ',
      todos: [{ text: 'Check on device', completed: true }]
    })
    expect(update).toEqual({
      title: 'Complete title', description: 'Details', comment: 'Internal note', priority: 'urgent',
      dueDate: '2026-08-30', labels: ['TestFlight', 'Regression'], categoryName: 'iOS',
      todos: [{ text: 'Check on device', completed: true }]
    })
    expect(importedTicketUpdateSchema.safeParse({ title: 'a'.repeat(10000) }).success).toBe(true)
    expect(importedTicketUpdateSchema.safeParse({ title: 'a'.repeat(10001) }).success).toBe(false)
  })
})
