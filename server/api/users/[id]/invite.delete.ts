import { clearInviteToken, findUser } from '~~/server/utils/db'
import { requireInstanceAdmin } from '~~/server/utils/access'

export default defineEventHandler((event) => {
  requireInstanceAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const target = findUser(id)
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Account not found.' })
  // The account stays; only the link stops working. Issuing a new one is a separate step,
  // so a misdirected invitation can be killed without handing out a replacement.
  clearInviteToken(id)
  setResponseStatus(event, 204)
  return null
})
