import { listActivity } from '~~/server/utils/db'
import { requireTicketAccess } from '~~/server/utils/access'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  requireTicketAccess(sessionActor(event), id)
  return { activity: listActivity(id) }
})
