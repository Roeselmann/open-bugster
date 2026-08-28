import { run, userRevokeInvite } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  await run(userRevokeInvite, sessionActor(event), { userId: getRouterParam(event, 'id') || '' })
  setResponseStatus(event, 204)
  return null
})
