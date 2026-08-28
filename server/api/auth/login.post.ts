import { findUserByEmail, touchLastLogin } from '~~/server/utils/db'
import { verifyStoredPassword } from '~~/server/utils/password'
import { loginSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const parsed = loginSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const account = findUserByEmail(parsed.data.email)
  const passwordMatches = Boolean(account?.passwordHash) && verifyStoredPassword(parsed.data.password, account!.passwordHash!)
  // One message for every failure: a wrong address must not be distinguishable from a
  // wrong password, and neither from an account that has been disabled.
  if (!account || account.status !== 'active' || !passwordMatches) {
    throw createError({ statusCode: 401, statusMessage: 'The email address or password is incorrect.' })
  }
  touchLastLogin(account.id)
  const user = {
    id: account.id,
    email: account.email!,
    firstName: account.firstName,
    lastName: account.lastName,
    role: account.role,
    sessionVersion: account.sessionVersion,
  }
  await setUserSession(event, { user, loggedInAt: new Date().toISOString() })
  return { user }
})
