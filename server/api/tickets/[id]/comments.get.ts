import { listComments } from '~~/server/utils/db'
import { requireTicketAccess } from '~~/server/utils/access'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  requireTicketAccess(event, id)
  return { comments: listComments(id) }
})
