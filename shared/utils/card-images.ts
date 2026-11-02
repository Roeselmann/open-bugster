import type { Ticket } from '../types/domain'

/** A picture a ticket's card can show: an image attachment, or the rendered preview of a link. */
export interface CardImage {
  id: string
  kind: 'attachment' | 'link'
  url: string
  /** The file's name, or the address the preview shows. */
  label: string
}

type CardImageSource = Pick<Ticket, 'attachments' | 'links' | 'cardImageIds'>

/**
 * Every picture of the ticket that could go on its card: the image attachments first, oldest
 * first, then the links shown as a preview whose page left a picture, in their order. A link
 * shown as plain text has asked not to be seen, so its picture is not offered either.
 */
export function cardImageCandidates(ticket: Pick<Ticket, 'attachments' | 'links'>): CardImage[] {
  const attachments = ticket.attachments
    .filter(attachment => attachment.mimeType.startsWith('image/'))
    .map(attachment => ({ id: attachment.id, kind: 'attachment' as const, url: attachment.url, label: attachment.filename }))
  const links = ticket.links.flatMap(link => link.display === 'preview' && link.preview.imageUrl
    ? [{ id: link.id, kind: 'link' as const, url: link.preview.imageUrl, label: link.preview.title || link.url }]
    : [])
  return [...attachments, ...links]
}

/**
 * The pictures the card shows, in the order of `cardImageCandidates`.
 *
 * Whatever somebody ticked, as long as one of it is still there — an empty pick is a choice
 * too, and shows none. Without a pick, or once every picked picture is gone, one picture: the
 * oldest image attachment, else the first link preview. An attachment is something somebody
 * put on the ticket on purpose, a preview only what the page happened to look like.
 */
export function cardImages(ticket: CardImageSource): CardImage[] {
  const candidates = cardImageCandidates(ticket)
  const picked = ticket.cardImageIds
  if (picked) {
    if (!picked.length) return []
    const chosen = candidates.filter(candidate => picked.includes(candidate.id))
    if (chosen.length) return chosen
  }
  const fallback = candidates.find(candidate => candidate.kind === 'attachment') ?? candidates[0]
  return fallback ? [fallback] : []
}
