import { run, boardDelete } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  await run(boardDelete, sessionActor(event), { boardId: getRouterParam(event, 'id') || '' })
  setResponseStatus(event, 204)
  return null
})
