import { setUserPassword } from '~~/server/utils/db'
import { accountForInviteToken } from '~~/server/utils/invite'
import { hashStoredPassword } from '~~/server/utils/password'
import { inviteAcceptSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const account = accountForInviteToken(getRouterParam(event, 'token') || '')
  const parsed = inviteAcceptSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)

  // Activates the account and retires the link in one step, so it is single-use. On a reset
  // this also bumps the session version, which signs out whoever was still using the old one.
  const activated = setUserPassword(account.id, hashStoredPassword(parsed.data.password))!
  const user = {
    id: activated.id,
    email: activated.email!,
    firstName: activated.firstName,
    lastName: activated.lastName,
    role: activated.role,
    sessionVersion: activated.sessionVersion,
  }
  await setUserSession(event, { user, loggedInAt: new Date().toISOString() })
  return { user }
})
