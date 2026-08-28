import { run, boardTestConnection } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(boardTestConnection, sessionActor(event), {
    ...(await readBody(event).catch(() => ({})) || {}),
    boardId: getRouterParam(event, 'id') || ''
  }))
