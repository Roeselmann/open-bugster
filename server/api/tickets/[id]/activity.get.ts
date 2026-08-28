import { run, ticketActivity } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(ticketActivity, sessionActor(event), { ticketId: getRouterParam(event, 'id') || '' }))
