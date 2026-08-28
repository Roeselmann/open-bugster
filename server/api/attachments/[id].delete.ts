import { realpath, unlink } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { deleteAttachment, findAttachment, findTicket } from '~~/server/utils/db'
import { requireTicketAccess } from '~~/server/utils/access'
import { getServerConfig } from '~~/server/utils/config'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const attachment = findAttachment(getRouterParam(event, 'id') || '')
  if (!attachment) throw createError({ statusCode: 404, statusMessage: 'Attachment not found.' })
  const { ticket } = requireTicketAccess(sessionActor(event), attachment.ticket_id, 'editor')
  if (ticket.source !== 'manual' || attachment.kind !== 'file') {
    throw createError({ statusCode: 403, statusMessage: 'Imported attachments cannot be deleted.' })
  }
  if (ticket.archivedAt) throw createError({ statusCode: 409, statusMessage: 'Attachments on archived tickets cannot be deleted.' })

  const configuredRoot = resolve(getServerConfig().attachmentsPath)
  const root = await realpath(configuredRoot).catch(() => configuredRoot)
  const candidate = resolve(root, attachment.relative_path)
  if (isAbsolute(attachment.relative_path) || (candidate !== root && !candidate.startsWith(`${root}${sep}`))) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid file path.' })
  }
  const actual = await realpath(candidate).catch(() => null)
  if (actual && (actual === root || actual.startsWith(`${root}${sep}`))) await unlink(actual)
  else if (actual) throw createError({ statusCode: 400, statusMessage: 'Invalid file path.' })

  deleteAttachment(attachment.id)
  return { ticket: findTicket(ticket.id)! }
})
