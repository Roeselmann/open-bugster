import { run, serviceDelete } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event => run(serviceDelete, sessionActor(event), { serviceId: getRouterParam(event, 'id') || '' }))
