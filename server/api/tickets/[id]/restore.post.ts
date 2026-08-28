import { run, ticketRestore } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(ticketRestore, sessionActor(event), { ticketId: getRouterParam(event, 'id') || '' }))
