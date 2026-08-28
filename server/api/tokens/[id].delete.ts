import { run, tokenRevoke } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  await run(tokenRevoke, sessionActor(event), { tokenId: getRouterParam(event, 'id') || '' })
  setResponseStatus(event, 204)
  return null
})
