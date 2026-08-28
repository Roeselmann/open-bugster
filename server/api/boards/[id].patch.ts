import { run, boardUpdate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(boardUpdate, sessionActor(event), { ...await readBody(event), boardId: getRouterParam(event, 'id') || '' }))
