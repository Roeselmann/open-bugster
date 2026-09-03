import { run, ticketTransfer } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(ticketTransfer, sessionActor(event), { ...await readBody(event), ticketId: getRouterParam(event, 'id') || '' }))
