import { run, ticketRoundReopen } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

// Opens the last closed round again: the undo of POST.
export default defineEventHandler(event =>
  run(ticketRoundReopen, sessionActor(event), { ticketId: getRouterParam(event, 'id') || '' }))
