import { run, webhookDeliveries } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(webhookDeliveries, sessionActor(event), { webhookId: getRouterParam(event, 'id') || '' }))
