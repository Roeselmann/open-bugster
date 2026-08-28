import { run, boardKeyClear } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(boardKeyClear, sessionActor(event), { boardId: getRouterParam(event, 'id') || '' }))
