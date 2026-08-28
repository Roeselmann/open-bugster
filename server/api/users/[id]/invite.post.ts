import { findUser, setInviteToken } from '~~/server/utils/db'
import { requireInstanceAdmin } from '~~/server/utils/access'
import { createInviteToken, inviteUrl } from '~~/server/utils/invite'

export default defineEventHandler((event) => {
  requireInstanceAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const target = findUser(id)
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Account not found.' })
  const invite = createInviteToken()
  setInviteToken(id, invite.hash, invite.expiresAt)
  return { inviteUrl: inviteUrl(event, invite.token) }
})
