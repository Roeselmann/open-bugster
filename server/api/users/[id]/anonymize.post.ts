import { anonymizeUser, findUser } from '~~/server/utils/db'
import { requireInstanceAdmin } from '~~/server/utils/access'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const account = requireInstanceAdmin(sessionActor(event))
  const id = getRouterParam(event, 'id') || ''
  const target = findUser(id)
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Account not found.' })
  if (target.role === 'owner') throw createError({ statusCode: 409, statusMessage: 'The owner account cannot be anonymized.' })
  if (target.id === account.id) throw createError({ statusCode: 409, statusMessage: 'You cannot anonymize your own account.' })

  // Everything this person touched keeps pointing at the row and stays where it is; what
  // goes is the name, the address, and any way back into the account.
  return { user: { ...anonymizeUser(id)!, passwordHash: undefined } }
})
