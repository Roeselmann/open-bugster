import { run, workspaceMemberRemove } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(workspaceMemberRemove, sessionActor(event), {
    workspaceId: getRouterParam(event, 'id') || '',
    userId: getRouterParam(event, 'userId') || ''
  }))
