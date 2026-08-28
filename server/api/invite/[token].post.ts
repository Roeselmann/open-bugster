import { findUserByInviteToken, setUserPassword } from '~~/server/utils/db'
import { hashInviteToken, inviteExpired } from '~~/server/utils/invite'
import { hashStoredPassword } from '~~/server/utils/password'
import { inviteAcceptSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const account = findUserByInviteToken(hashInviteToken(getRouterParam(event, 'token') || ''))
  if (!account || inviteExpired(account.inviteExpiresAt)) {
    throw createError({ statusCode: 404, statusMessage: 'This invitation is no longer valid. Ask an administrator for a new link.' })
  }
  const parsed = inviteAcceptSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)

  // Activates the account and retires the invite in one step, so the link is single-use.
  const activated = setUserPassword(account.id, hashStoredPassword(parsed.data.password))!
  const user = {
    id: activated.id,
    email: activated.email,
    firstName: activated.firstName,
    lastName: activated.lastName,
    role: activated.role,
    sessionVersion: activated.sessionVersion,
  }
  await setUserSession(event, { user, loggedInAt: new Date().toISOString() })
  return { user }
})
