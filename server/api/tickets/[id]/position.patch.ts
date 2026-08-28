import { run, ticketMove } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(ticketMove, sessionActor(event), { ...await readBody(event), ticketId: getRouterParam(event, 'id') || '' }))
