import { findBoard, listTickets } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  const boardId = String(query.boardId || '')
  if (!findBoard(boardId)) throw createError({ statusCode: 404, statusMessage: 'Board not found.' })
  return { tickets: listTickets(boardId, query.archived === 'true') }
})
