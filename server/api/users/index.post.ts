import { createUser, EmailTakenError, setInviteToken } from '~~/server/utils/db'
import { requireInstanceAdmin } from '~~/server/utils/access'
import { createInviteToken, inviteUrl } from '~~/server/utils/invite'
import { userCreateSchema, validationError } from '~~/server/utils/validation'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  requireInstanceAdmin(sessionActor(event))
  const parsed = userCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)

  try {
    const account = createUser(parsed.data)
    const invite = createInviteToken()
    setInviteToken(account.id, invite.hash, invite.expiresAt)
    setResponseStatus(event, 201)
    // The only time the raw token is ever visible. It is not stored anywhere in the clear.
    return { user: { ...account, passwordHash: undefined }, inviteUrl: inviteUrl(event, invite.token) }
  } catch (error) {
    if (error instanceof EmailTakenError) throw createError({ statusCode: 409, statusMessage: error.message })
    throw error
  }
})
