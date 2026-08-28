import { setUserPassword } from '~~/server/utils/db'

import { hashStoredPassword, verifyStoredPassword } from '~~/server/utils/password'
import { passwordChangeSchema, validationError } from '~~/server/utils/validation'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const account = sessionActor(event).principal
  const parsed = passwordChangeSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  if (!account.passwordHash || !verifyStoredPassword(parsed.data.currentPassword, account.passwordHash)) {
    throw createError({ statusCode: 401, statusMessage: 'The current password is incorrect.' })
  }
  // Bumps the session version, so every other signed-in device is logged out.
  const updated = setUserPassword(account.id, hashStoredPassword(parsed.data.newPassword))!
  await replaceUserSession(event, {
    user: {
      id: updated.id,
      email: updated.email!,
      firstName: updated.firstName,
      lastName: updated.lastName,
      role: updated.role,
      sessionVersion: updated.sessionVersion,
    },
    loggedInAt: new Date().toISOString(),
  })
  return { ok: true }
})
