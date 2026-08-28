import { run, webhookUpdate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(webhookUpdate, sessionActor(event), { ...await readBody(event), webhookId: getRouterParam(event, 'id') || '' }))
