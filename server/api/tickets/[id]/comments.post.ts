import { run, commentAdd } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const result = await run(commentAdd, sessionActor(event), { ...await readBody(event), ticketId: getRouterParam(event, 'id') || '' })
  setResponseStatus(event, 201)
  return result
})
