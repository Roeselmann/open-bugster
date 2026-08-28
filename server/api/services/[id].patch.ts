import { run, serviceSetStatus } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(serviceSetStatus, sessionActor(event), { ...await readBody(event), serviceId: getRouterParam(event, 'id') || '' }))
