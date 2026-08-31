import { run, workspaceMemberCandidates } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(workspaceMemberCandidates, sessionActor(event), { workspaceId: getRouterParam(event, 'id') || '' }))
