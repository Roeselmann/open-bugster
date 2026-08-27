import { findBoard, listLabels } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const boardId = String(getQuery(event).boardId || '')
  if (!findBoard(boardId)) throw createError({ statusCode: 404, statusMessage: 'Board not found.' })
  return { labels: listLabels(boardId) }
})
