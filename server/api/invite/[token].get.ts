import { findUserByInviteToken } from '~~/server/utils/db'
import { hashInviteToken, inviteExpired } from '~~/server/utils/invite'

export default defineEventHandler((event) => {
  const account = findUserByInviteToken(hashInviteToken(getRouterParam(event, 'token') || ''))
  if (!account || inviteExpired(account.inviteExpiresAt)) {
    throw createError({ statusCode: 404, statusMessage: 'This invitation is no longer valid. Ask an administrator for a new link.' })
  }
  return { invite: { email: account.email, firstName: account.firstName, lastName: account.lastName } }
})
