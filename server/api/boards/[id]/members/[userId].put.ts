import { run, memberSet } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(memberSet, sessionActor(event), {
    ...await readBody(event),
    boardId: getRouterParam(event, 'id') || '',
    userId: getRouterParam(event, 'userId') || ''
  }))
