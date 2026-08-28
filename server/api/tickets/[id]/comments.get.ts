import { run, commentList } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(commentList, sessionActor(event), { ticketId: getRouterParam(event, 'id') || '' }))
