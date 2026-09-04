import { run, importStatus } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  return run(importStatus, sessionActor(event), {
    boardId: String(query.boardId || ''),
    ...(query.provider ? { provider: String(query.provider) } : {})
  })
})
