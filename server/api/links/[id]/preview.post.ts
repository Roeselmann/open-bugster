import { findTicketLink } from '~~/server/utils/db'
import { requireTicketAccess } from '~~/server/utils/access'
import { refreshLinkPreview } from '~~/server/utils/link-preview'
import { sessionActor } from '~~/server/utils/actor'

/**
 * Fills in a link's preview. The ticket editor asks for it when it shows a link still
 * `pending`, which is what keeps a save fast and a sync of a hundred Jira issues from
 * reading a hundred pages: a page is only read once somebody looks at its ticket.
 *
 * Anyone who can read the ticket may fill a preview that is missing — it is a cache, and the
 * page is the one the ticket already names. Reading it again over an existing preview
 * (`refresh`) changes what everybody sees, so that is for editors.
 */
export default defineEventHandler(async (event) => {
  const link = findTicketLink(getRouterParam(event, 'id') || '')
  if (!link) throw createError({ statusCode: 404, statusMessage: 'Link not found.' })
  const body = await readBody<{ refresh?: boolean } | null>(event).catch(() => null)
  const refresh = body?.refresh === true
  requireTicketAccess(sessionActor(event), link.ticketId, refresh ? 'editor' : 'viewer')
  if (refresh || link.preview.status === 'pending') await refreshLinkPreview(link.id)
  const current = findTicketLink(link.id)
  if (!current) throw createError({ statusCode: 404, statusMessage: 'Link not found.' })
  const { ticketId: _ticketId, imagePath: _imagePath, ...result } = current
  return { link: result }
})
