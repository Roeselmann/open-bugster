import { run, jiraTokenSet } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'
import { SecretBoxError } from '~~/server/utils/secret-box'

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({})) || {}
  try {
    return await run(jiraTokenSet, sessionActor(event), { ...body, boardId: getRouterParam(event, 'id') || '' })
  } catch (error) {
    if (error instanceof SecretBoxError) throw createError({ statusCode: 500, statusMessage: error.message })
    throw error
  }
})
