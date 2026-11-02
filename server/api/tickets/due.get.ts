import { run, ticketDueList } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event => run(ticketDueList, sessionActor(event), {}))
