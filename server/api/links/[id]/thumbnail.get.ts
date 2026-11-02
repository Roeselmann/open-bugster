import { createReadStream } from 'node:fs'
import { findTicketLink } from '~~/server/utils/db'
import { requireTicketAccess } from '~~/server/utils/access'
import { resolveAttachmentFile } from '~~/server/utils/attachment-file'
import { sessionActor } from '~~/server/utils/actor'

/**
 * A link's thumbnail. Served from here rather than hot-linked from the page it came from:
 * the content policy keeps images to this origin, and a remote image would tell the site
 * every time somebody opened the ticket.
 */
export default defineEventHandler(async (event) => {
  const link = findTicketLink(getRouterParam(event, 'id') || '')
  if (!link?.imagePath) throw createError({ statusCode: 404, statusMessage: 'Thumbnail not found.' })
  // Reached by id alone, so the board it belongs to has to be checked explicitly.
  requireTicketAccess(sessionActor(event), link.ticketId)
  const actual = await resolveAttachmentFile(link.imagePath)
  setHeader(event, 'Content-Type', 'image/jpeg')
  setHeader(event, 'Cache-Control', 'private, max-age=3600')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  return sendStream(event, createReadStream(actual))
})
