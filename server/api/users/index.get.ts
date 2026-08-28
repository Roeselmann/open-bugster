import { listUsers } from '~~/server/utils/db'
import { requireInstanceAdmin } from '~~/server/utils/access'

export default defineEventHandler((event) => {
  requireInstanceAdmin(event)
  return { users: listUsers() }
})
