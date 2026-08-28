import { listUsers } from '~~/server/utils/db'
import { requireInstanceAdmin } from '~~/server/utils/access'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  requireInstanceAdmin(sessionActor(event))
  return { users: listUsers() }
})
