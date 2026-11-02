import { describe, expect, it } from 'vitest'
import type { Attachment, TicketLink } from '../shared/types/domain'
import { cardImageCandidates, cardImages } from '../shared/utils/card-images'

const image = (id: string): Attachment => ({ id, kind: 'file', filename: `${id}.png`, mimeType: 'image/png', size: 1, url: `/api/attachments/${id}` })
const log: Attachment = { id: 'log', kind: 'file', filename: 'crash.log', mimeType: 'text/plain', size: 1, url: '/api/attachments/log' }
const link = (id: string, display: 'preview' | 'text', rendered = true): TicketLink => ({
  id, url: `https://${id}.example`, display, position: 0,
  preview: { status: rendered ? 'ready' : 'none', title: id, description: null, siteName: null, imageUrl: rendered ? `/api/links/${id}/thumbnail?v=1` : null }
})
const ids = (ticket: Parameters<typeof cardImages>[0]) => cardImages(ticket).map(picture => picture.id)

describe('the pictures on a card', () => {
  it('offers image attachments first, then links shown with a rendered preview', () => {
    const offered = cardImageCandidates({ attachments: [log, image('a')], links: [link('plain', 'text'), link('blank', 'preview', false), link('page', 'preview')] })
    expect(offered.map(picture => [picture.id, picture.kind])).toEqual([['a', 'attachment'], ['page', 'link']])
  })

  it('shows the oldest image attachment by default, and a link preview only without one', () => {
    expect(ids({ attachments: [image('a'), image('b')], links: [link('page', 'preview')], cardImageIds: null })).toEqual(['a'])
    expect(ids({ attachments: [log], links: [link('page', 'preview'), link('other', 'preview')], cardImageIds: null })).toEqual(['page'])
    expect(ids({ attachments: [log], links: [link('plain', 'text')], cardImageIds: null })).toEqual([])
  })

  it('shows exactly what was ticked, none for an empty pick, and the default once the pick is gone', () => {
    const ticket = { attachments: [image('a'), image('b')], links: [link('page', 'preview')] }
    expect(ids({ ...ticket, cardImageIds: ['page', 'b'] })).toEqual(['b', 'page'])
    expect(ids({ ...ticket, cardImageIds: [] })).toEqual([])
    expect(ids({ ...ticket, cardImageIds: ['gone'] })).toEqual(['a'])
    // A link switched back to text takes its picture off the card.
    expect(ids({ attachments: [], links: [link('page', 'text')], cardImageIds: ['page'] })).toEqual([])
  })
})
