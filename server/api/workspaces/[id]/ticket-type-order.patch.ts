import { run, ticketTypeReorder } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(ticketTypeReorder, sessionActor(event), { ...await readBody(event), workspaceId: getRouterParam(event, 'id') || '' }))
