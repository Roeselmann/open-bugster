import { createReadStream } from 'node:fs'
import { findAttachment } from '~~/server/utils/db'
import { requireTicketAccess } from '~~/server/utils/access'
import { safeAttachmentName } from '~~/server/utils/app-store-connect'
import { resolveAttachmentFile } from '~~/server/utils/attachment-file'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const attachment = findAttachment(getRouterParam(event, 'id') || '')
  if (!attachment) throw createError({ statusCode: 404, statusMessage: 'Attachment not found.' })
  // Reached by id alone, so the board it belongs to has to be checked explicitly.
  requireTicketAccess(sessionActor(event), attachment.ticket_id)
  const actual = await resolveAttachmentFile(attachment.relative_path)
  setHeader(event, 'Content-Type', attachment.mime_type)
  setHeader(event, 'Content-Length', attachment.size)
  // The UI shows images in a lightbox, so they are served for display; anything else is a
  // download. The public API takes the stricter line — see the v1 dispatcher.
  const disposition = attachment.mime_type.startsWith('image/') ? 'inline' : 'attachment'
  setHeader(event, 'Content-Disposition', `${disposition}; filename="${safeAttachmentName(attachment.filename)}"`)
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  return sendStream(event, createReadStream(actual))
})
