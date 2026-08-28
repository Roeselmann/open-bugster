import { run, userUpdate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(userUpdate, sessionActor(event), { ...await readBody(event), userId: getRouterParam(event, 'id') || '' }))
