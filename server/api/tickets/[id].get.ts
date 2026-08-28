import { requireTicketAccess } from '~~/server/utils/access'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const { ticket } = requireTicketAccess(sessionActor(event), getRouterParam(event, 'id') || '')
  return { ticket }
})
