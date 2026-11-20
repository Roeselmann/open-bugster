import { run, ticketRoundClose } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async event =>
  run(ticketRoundClose, sessionActor(event), { ...await readBody(event).catch(() => ({})), ticketId: getRouterParam(event, 'id') || '' }))
