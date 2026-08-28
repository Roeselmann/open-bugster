import { run, webhookDelete } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  await run(webhookDelete, sessionActor(event), { webhookId: getRouterParam(event, 'id') || '' })
  setResponseStatus(event, 204)
  return null
})
