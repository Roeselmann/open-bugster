import { describe, expect, it } from 'vitest'
import { boardUpdateSchema, connectionTestSchema, importedTicketUpdateSchema, ticketCreateSchema, ticketMoveSchema, ticketUpdateSchema } from '../server/utils/validation'

describe('ticket validation', () => {
  it('normalizes a valid manual ticket', () => {
    const result = ticketCreateSchema.parse({ boardId: 'board-1', title: '  Fix login  ', buildNumber: ' 42 ', labels: ['Auth'] })
    expect(result).toEqual({ boardId: 'board-1', title: 'Fix login', description: '', priority: 'medium', buildNumber: '42', labels: ['Auth'], todos: [] })
  })

  it('rejects empty titles and invalid board moves', () => {
    expect(ticketCreateSchema.safeParse({ title: '   ', boardId: 'board-1' }).success).toBe(false)
    expect(ticketMoveSchema.safeParse({ laneId: '', index: 0 }).success).toBe(false)
    expect(ticketMoveSchema.safeParse({ laneId: 'lane-1', index: -1 }).success).toBe(false)
  })

  it('moves a ticket to a lane by id', () => {
    expect(ticketMoveSchema.parse({ laneId: 'lane-1', index: 3 })).toEqual({ laneId: 'lane-1', index: 3 })
  })

  it('requires a board when creating a ticket', () => {
    expect(ticketCreateSchema.safeParse({ title: 'Ticket' }).success).toBe(false)
  })

  it('normalizes optional category names', () => {
    expect(ticketCreateSchema.parse({ boardId: 'board-1', title: 'Ticket', categoryName: '  Frontend  ' }).categoryName).toBe('Frontend')
    expect(ticketCreateSchema.parse({ boardId: 'board-1', title: 'Ticket', categoryName: null }).categoryName).toBeNull()
    expect(ticketCreateSchema.safeParse({ boardId: 'board-1', title: 'Ticket', categoryName: 'x'.repeat(31) }).success).toBe(false)
  })

  it('validates and normalizes ticket todos', () => {
    expect(ticketCreateSchema.parse({
      boardId: 'board-1',
      title: 'Ticket',
      todos: [{ text: '  Reproduce the issue  ', completed: false }]
    }).todos).toEqual([{ text: 'Reproduce the issue', completed: false }])
    expect(ticketCreateSchema.safeParse({ boardId: 'board-1', title: 'Ticket', todos: [{ text: '   ', completed: false }] }).success).toBe(false)
    expect(ticketCreateSchema.safeParse({ boardId: 'board-1', title: 'Ticket', todos: [{ text: 'x'.repeat(501), completed: false }] }).success).toBe(false)
    expect(ticketCreateSchema.safeParse({ boardId: 'board-1', title: 'Ticket', todos: Array.from({ length: 101 }, (_, index) => ({ text: `To-do ${index}`, completed: false })) }).success).toBe(false)
    expect(ticketUpdateSchema.parse({ priority: 'high' })).toEqual({ priority: 'high' })
  })

  it('allows all regular fields of imported tickets to be updated', () => {
    const update = importedTicketUpdateSchema.parse({
      title: '  Complete title  ', description: 'Details', priority: 'urgent',
      dueDate: '2026-08-30', labels: ['TestFlight', 'Regression'], categoryName: ' iOS ',
      todos: [{ text: 'Check on device', completed: true }]
    })
    expect(update).toEqual({
      title: 'Complete title', description: 'Details', priority: 'urgent',
      dueDate: '2026-08-30', labels: ['TestFlight', 'Regression'], categoryName: 'iOS',
      todos: [{ text: 'Check on device', completed: true }]
    })
    expect(importedTicketUpdateSchema.safeParse({ title: 'a'.repeat(10000) }).success).toBe(true)
    expect(importedTicketUpdateSchema.safeParse({ title: 'a'.repeat(10001) }).success).toBe(false)
  })

  it('bounds the submission limit of a board', () => {
    expect(boardUpdateSchema.parse({ syncLimit: 25 })).toEqual({ syncLimit: 25 })
    expect(boardUpdateSchema.safeParse({ syncLimit: 0 }).success).toBe(false)
    expect(boardUpdateSchema.safeParse({ syncLimit: 2001 }).success).toBe(false)
    expect(boardUpdateSchema.safeParse({ syncLimit: 12.5 }).success).toBe(false)
    // Every field stays optional, so saving only the name is still valid.
    expect(boardUpdateSchema.parse({ name: 'Radio app' })).toEqual({ name: 'Radio app' })
  })

  it('takes the credentials of a connection test from the request', () => {
    expect(connectionTestSchema.parse({ issuerId: '  issuer  ', keyId: 'KEY123', appId: '42' }))
      .toEqual({ issuerId: 'issuer', keyId: 'KEY123', appId: '42' })
    // An empty body falls back to the stored credentials in the handler.
    expect(connectionTestSchema.parse({})).toEqual({})
    // The private key is never accepted from the client.
    expect(connectionTestSchema.parse({ privateKey: 'secret' })).toEqual({})
    expect(connectionTestSchema.safeParse({ appId: 'x'.repeat(121) }).success).toBe(false)
  })
})
