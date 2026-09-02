import { describe, expect, it } from 'vitest'
import { boardUpdateSchema, connectionTestSchema, importedTicketUpdateSchema, ticketCreateSchema, ticketMoveSchema, ticketTypeCreateSchema, ticketUpdateSchema } from '../server/utils/validation'

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

  it('takes a type by id, or none at all', () => {
    expect(ticketCreateSchema.parse({ boardId: 'board-1', title: 'Ticket' })).not.toHaveProperty('typeId')
    expect(ticketCreateSchema.parse({ boardId: 'board-1', title: 'Ticket', typeId: null }).typeId).toBeNull()
    expect(ticketCreateSchema.parse({ boardId: 'board-1', title: 'Ticket', typeId: ' type-1 ' }).typeId).toBe('type-1')
    expect(ticketUpdateSchema.parse({ typeId: null })).toEqual({ typeId: null })
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

  it('names people by id, and offers attribution only on imported tickets', () => {
    expect(ticketUpdateSchema.parse({ assigneeId: 'user-1' })).toEqual({ assigneeId: 'user-1' })
    // Clearing is a null, which is not the same as leaving the field out.
    expect(ticketUpdateSchema.parse({ assigneeId: null })).toEqual({ assigneeId: null })
    expect(ticketUpdateSchema.safeParse({ assigneeId: '' }).success).toBe(false)
    // An address is no longer a way to name somebody: an anonymized person has none.
    expect(ticketCreateSchema.parse({ boardId: 'board-1', title: 'Ticket', assigneeId: 'user-1' }).assigneeId).toBe('user-1')

    expect(importedTicketUpdateSchema.parse({ authorId: 'user-1' })).toEqual({ authorId: 'user-1' })
    expect(importedTicketUpdateSchema.parse({ authorId: null })).toEqual({ authorId: null })
    // A ticket filed here already knows its author, so the manual schema drops the field.
    expect(ticketUpdateSchema.parse({ authorId: 'user-1' } as never)).toEqual({})
  })

  it('bounds the submission limit of a board', () => {
    expect(boardUpdateSchema.parse({ syncLimit: 25 })).toEqual({ syncLimit: 25 })
    expect(boardUpdateSchema.safeParse({ syncLimit: 0 }).success).toBe(false)
    expect(boardUpdateSchema.safeParse({ syncLimit: 2001 }).success).toBe(false)
    expect(boardUpdateSchema.safeParse({ syncLimit: 12.5 }).success).toBe(false)
    // Every field stays optional, so saving only the name is still valid.
    expect(boardUpdateSchema.parse({ name: 'Radio app' })).toEqual({ name: 'Radio app' })
  })

  it('carries the per-board auto-author switch', () => {
    expect(boardUpdateSchema.parse({ autoAuthor: false })).toEqual({ autoAuthor: false })
    expect(boardUpdateSchema.safeParse({ autoAuthor: 'yes' }).success).toBe(false)
  })

  it('takes the import type by id, or clears it with null', () => {
    expect(boardUpdateSchema.parse({ importTypeId: ' type-1 ' })).toEqual({ importTypeId: 'type-1' })
    expect(boardUpdateSchema.parse({ importTypeId: null })).toEqual({ importTypeId: null })
    expect(boardUpdateSchema.parse({ name: 'Radio app' })).not.toHaveProperty('importTypeId')
    expect(boardUpdateSchema.safeParse({ importTypeId: '' }).success).toBe(false)
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

describe('ticket type validation', () => {
  const png = `data:image/png;base64,${Buffer.from('not really a png').toString('base64')}`

  it('defaults a new type to a neutral lucide ticket', () => {
    expect(ticketTypeCreateSchema.parse({ name: '  Email ' })).toEqual({ name: 'Email', color: 'neutral', icon: { kind: 'lucide', name: 'Ticket' } })
  })

  it('accepts a curated lucide icon or a small PNG, and nothing else', () => {
    expect(ticketTypeCreateSchema.safeParse({ name: 'Email', icon: { kind: 'lucide', name: 'Mail' } }).success).toBe(true)
    expect(ticketTypeCreateSchema.safeParse({ name: 'Email', icon: { kind: 'lucide', name: 'NotAnIcon' } }).success).toBe(false)
    expect(ticketTypeCreateSchema.safeParse({ name: 'Email', icon: { kind: 'image', dataUrl: png } }).success).toBe(true)
    expect(ticketTypeCreateSchema.safeParse({ name: 'Email', icon: { kind: 'image', dataUrl: png.replace('image/png', 'image/jpeg') } }).success).toBe(false)
    expect(ticketTypeCreateSchema.safeParse({ name: 'Email', icon: { kind: 'image', dataUrl: 'https://example.com/icon.png' } }).success).toBe(false)
  })

  it('caps an uploaded icon at 64 KB', () => {
    const huge = `data:image/png;base64,${'A'.repeat(64 * 1024)}`
    expect(ticketTypeCreateSchema.safeParse({ name: 'Email', icon: { kind: 'image', dataUrl: huge } }).success).toBe(false)
  })

  it('bounds the name and the colour', () => {
    expect(ticketTypeCreateSchema.safeParse({ name: '   ' }).success).toBe(false)
    expect(ticketTypeCreateSchema.safeParse({ name: 'x'.repeat(31) }).success).toBe(false)
    expect(ticketTypeCreateSchema.safeParse({ name: 'Email', color: 'chartreuse' }).success).toBe(false)
    expect(ticketTypeCreateSchema.parse({ name: 'Plain', color: 'none' }).color).toBe('none')
  })
})
