import { run, memberRemove } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(memberRemove, sessionActor(event), {
    boardId: getRouterParam(event, 'id') || '',
    userId: getRouterParam(event, 'userId') || ''
  }))
