import { run, ticketTypeDelete } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  await run(ticketTypeDelete, sessionActor(event), { typeId: getRouterParam(event, 'id') || '' })
  setResponseStatus(event, 204)
  return null
})
