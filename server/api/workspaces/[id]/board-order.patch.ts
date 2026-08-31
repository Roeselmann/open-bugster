import { run, workspaceBoardOrder } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(workspaceBoardOrder, sessionActor(event), { ...await readBody(event), workspaceId: getRouterParam(event, 'id') || '' }))
