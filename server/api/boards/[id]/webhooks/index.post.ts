import { run, webhookCreate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const result = await run(webhookCreate, sessionActor(event), { ...await readBody(event), boardId: getRouterParam(event, 'id') || '' })
  setResponseStatus(event, 201)
  // `secret` is in this response and nowhere else, ever again.
  return result
})
