import { run, ticketParentsList } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event => run(ticketParentsList, sessionActor(event), { ticketId: getRouterParam(event, 'id') || '' }))
