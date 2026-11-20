import { run, ticketDependentsList } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event => run(ticketDependentsList, sessionActor(event), { ticketId: getRouterParam(event, 'id') || '' }))
