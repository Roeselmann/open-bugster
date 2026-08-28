import { run, ticketUpdate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(ticketUpdate, sessionActor(event), { ...await readBody(event), ticketId: getRouterParam(event, 'id') || '' }))
