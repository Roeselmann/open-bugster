import { run, laneCreate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const result = await run(laneCreate, sessionActor(event), { ...await readBody(event), boardId: getRouterParam(event, 'id') || '' })
  setResponseStatus(event, 201)
  return result
})
