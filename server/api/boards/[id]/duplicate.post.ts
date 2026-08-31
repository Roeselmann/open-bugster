import { run, boardDuplicate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const result = await run(boardDuplicate, sessionActor(event), { ...await readBody(event), boardId: getRouterParam(event, 'id') || '' })
  setResponseStatus(event, 201)
  return result
})
