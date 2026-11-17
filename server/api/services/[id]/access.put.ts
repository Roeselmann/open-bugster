import { run, serviceSetAccess } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(serviceSetAccess, sessionActor(event), { ...await readBody(event), serviceId: getRouterParam(event, 'id') || '' }))
