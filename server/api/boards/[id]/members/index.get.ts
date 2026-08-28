import { run, memberList } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(memberList, sessionActor(event), { boardId: getRouterParam(event, 'id') || '' }))
