import { run, categoryUpdate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(categoryUpdate, sessionActor(event), { ...await readBody(event), categoryId: getRouterParam(event, 'id') || '' }))
