import { updateUser } from '~~/server/utils/db'
import { requireAuthUser } from '~~/server/utils/access'
import { profileUpdateSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const account = requireAuthUser(event)
  const parsed = profileUpdateSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const updated = updateUser(account.id, parsed.data)!
  // The session carries the display name, so it has to be refreshed alongside the row.
  await replaceUserSession(event, {
    user: {
      id: updated.id,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
      role: updated.role,
      sessionVersion: updated.sessionVersion,
    },
    loggedInAt: new Date().toISOString(),
  })
  return { user: { ...updated, passwordHash: undefined } }
})
