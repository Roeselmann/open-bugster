import { deleteUser, findUser } from '~~/server/utils/db'
import { requireInstanceAdmin } from '~~/server/utils/access'

export default defineEventHandler((event) => {
  const account = requireInstanceAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const target = findUser(id)
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Account not found.' })
  if (target.role === 'owner') throw createError({ statusCode: 409, statusMessage: 'The owner account cannot be deleted.' })
  if (target.id === account.id) throw createError({ statusCode: 409, statusMessage: 'You cannot delete your own account.' })
  // Tickets, comments, and activity keep the address they were written with, so the
  // history stays readable — it simply stops resolving to an account.
  deleteUser(id)
  setResponseStatus(event, 204)
  return null
})
