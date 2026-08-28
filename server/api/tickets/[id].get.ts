import { run, ticketGet } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(ticketGet, sessionActor(event), { ticketId: getRouterParam(event, 'id') || '' }))
