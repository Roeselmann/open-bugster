import { boardTimelineGet, run } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event => run(boardTimelineGet, sessionActor(event), { boardId: getRouterParam(event, 'id') || '' }))
