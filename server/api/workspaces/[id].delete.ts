import { run, workspaceDelete } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  await run(workspaceDelete, sessionActor(event), { workspaceId: getRouterParam(event, 'id') || '' })
  setResponseStatus(event, 204)
  return null
})
