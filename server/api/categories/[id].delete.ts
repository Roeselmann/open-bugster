import { run, categoryDelete } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  await run(categoryDelete, sessionActor(event), { categoryId: getRouterParam(event, 'id') || '' })
  setResponseStatus(event, 204)
  return null
})
