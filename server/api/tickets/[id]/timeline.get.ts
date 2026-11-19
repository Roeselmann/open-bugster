import { run, ticketTimelineGet } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event => run(ticketTimelineGet, sessionActor(event), { ticketId: getRouterParam(event, 'id') || '' }))
