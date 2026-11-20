import { run, ticketShift } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(ticketShift, sessionActor(event), { ...await readBody(event), ticketId: getRouterParam(event, 'id') || '' }))
