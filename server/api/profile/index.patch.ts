import { AnonymizedAccountError, EmailTakenError, updateUser } from '~~/server/utils/db'

import { profileUpdateSchema, validationError } from '~~/server/utils/validation'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const account = sessionActor(event).principal
  const parsed = profileUpdateSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  let updated
  try {
    updated = updateUser(account.id, parsed.data)!
  } catch (error) {
    if (error instanceof EmailTakenError || error instanceof AnonymizedAccountError) {
      throw createError({ statusCode: 409, statusMessage: error.message })
    }
    throw error
  }
  // The session carries the display name and address, so it has to be refreshed alongside
  // the row. Only an anonymized account has no address, and the auth middleware turns those
  // away as disabled, so a session always has one.
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
  return { user: { ...updated, passwordHash: undefined } }
})
