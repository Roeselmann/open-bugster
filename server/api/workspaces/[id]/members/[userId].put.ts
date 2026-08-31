import { run, workspaceMemberSet } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(workspaceMemberSet, sessionActor(event), {
    ...await readBody(event),
    workspaceId: getRouterParam(event, 'id') || '',
    userId: getRouterParam(event, 'userId') || ''
  }))
