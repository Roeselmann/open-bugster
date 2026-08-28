import { run, commentRemove } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  await run(commentRemove, sessionActor(event), { commentId: getRouterParam(event, 'id') || '' })
  setResponseStatus(event, 204)
  return null
})
