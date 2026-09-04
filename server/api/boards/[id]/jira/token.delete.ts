import { run, jiraTokenClear } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(jiraTokenClear, sessionActor(event), { boardId: getRouterParam(event, 'id') || '' }))
