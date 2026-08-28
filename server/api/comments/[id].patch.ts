import { run, commentUpdate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(commentUpdate, sessionActor(event), { ...await readBody(event), commentId: getRouterParam(event, 'id') || '' }))
