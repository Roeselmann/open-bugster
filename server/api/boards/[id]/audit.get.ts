import { run, auditList } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  return run(auditList, sessionActor(event), {
    boardId: getRouterParam(event, 'id') || '',
    operation: query.operation ? String(query.operation) : undefined,
    limit: query.limit ? Number(query.limit) : undefined
  })
})
