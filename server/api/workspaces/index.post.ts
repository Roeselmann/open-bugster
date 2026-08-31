import { run, workspaceCreate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const result = await run(workspaceCreate, sessionActor(event), await readBody(event))
  setResponseStatus(event, 201)
  return result
})
