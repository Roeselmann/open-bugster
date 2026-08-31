import { run, workspaceUpdate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(workspaceUpdate, sessionActor(event), { ...await readBody(event), workspaceId: getRouterParam(event, 'id') || '' }))
