import { run, ticketTypeList } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  return run(ticketTypeList, sessionActor(event), {
    workspaceId: query.workspaceId ? String(query.workspaceId) : undefined,
    boardId: query.boardId ? String(query.boardId) : undefined
  })
})
