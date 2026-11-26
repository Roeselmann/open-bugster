import { run, boardGetDeletionImpact } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(boardGetDeletionImpact, sessionActor(event), { boardId: getRouterParam(event, 'id') || '' }))
