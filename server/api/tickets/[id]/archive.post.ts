import { run, ticketArchive } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(ticketArchive, sessionActor(event), { ticketId: getRouterParam(event, 'id') || '' }))
