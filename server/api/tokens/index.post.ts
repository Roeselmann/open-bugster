import { run, tokenCreate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const result = await run(tokenCreate, sessionActor(event), await readBody(event))
  setResponseStatus(event, 201)
  // `secret` is in this response and nowhere else, ever again.
  return result
})
