import { run, webhookList } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(webhookList, sessionActor(event), { boardId: getRouterParam(event, 'id') || '' }))
