import { run, memberCandidates } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(memberCandidates, sessionActor(event), { boardId: getRouterParam(event, 'id') || '' }))
