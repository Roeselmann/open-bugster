import { requireTicketAccess } from '~~/server/utils/access'

export default defineEventHandler((event) => {
  const { ticket } = requireTicketAccess(event, getRouterParam(event, 'id') || '')
  return { ticket }
})
