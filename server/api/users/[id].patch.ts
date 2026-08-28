import { AnonymizedAccountError, EmailTakenError, findUser, updateUser } from '~~/server/utils/db'
import { requireInstanceAdmin } from '~~/server/utils/access'
import { userUpdateSchema, validationError } from '~~/server/utils/validation'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const account = requireInstanceAdmin(sessionActor(event))
  const id = getRouterParam(event, 'id') || ''
  const target = findUser(id)
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Account not found.' })

  const parsed = userUpdateSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const changesAccess = parsed.data.role !== undefined || parsed.data.status !== undefined

  if (target.role === 'owner' && changesAccess) {
    throw createError({ statusCode: 409, statusMessage: 'The owner account cannot be demoted or disabled.' })
  }
  if (target.id === account.id && changesAccess) {
    throw createError({ statusCode: 409, statusMessage: 'You cannot change your own role or status.' })
  }
  try {
    return { user: { ...updateUser(id, parsed.data)!, passwordHash: undefined } }
  } catch (error) {
    if (error instanceof EmailTakenError || error instanceof AnonymizedAccountError) {
      throw createError({ statusCode: 409, statusMessage: error.message })
    }
    throw error
  }
})
