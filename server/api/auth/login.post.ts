import { loginSchema, validationError } from '~~/server/utils/validation'
import { verifyStoredPassword } from '~~/server/utils/password'
import { getServerConfig } from '~~/server/utils/config'

export default defineEventHandler(async (event) => {
  const parsed = loginSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const config = getServerConfig()
  const usernameMatches = parsed.data.username === config.appUsername
  const passwordMatches = verifyStoredPassword(parsed.data.password, config.appPasswordHash)
  if (!usernameMatches || !passwordMatches) {
    throw createError({ statusCode: 401, statusMessage: 'The username or password is incorrect.' })
  }
  const user = {
    username: parsed.data.username,
    firstName: config.adminFirstName,
    lastName: config.adminLastName,
    email: config.adminEmail,
  }
  await setUserSession(event, { user, loggedInAt: new Date().toISOString() })
  return { user }
})
