import { run, ticketTypeUpdate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(ticketTypeUpdate, sessionActor(event), { ...await readBody(event), typeId: getRouterParam(event, 'id') || '' }))
