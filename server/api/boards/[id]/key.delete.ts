import { clearBoardPrivateKey } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const board = clearBoardPrivateKey(getRouterParam(event, 'id') || '')
  if (!board) throw createError({ statusCode: 404, statusMessage: 'Board not found.' })
  return { board }
})
