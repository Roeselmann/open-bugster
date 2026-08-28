import { run, serviceCreate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const result = await run(serviceCreate, sessionActor(event), await readBody(event))
  setResponseStatus(event, 201)
  return result
})
