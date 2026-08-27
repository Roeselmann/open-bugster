import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { countBoards, deleteBoard } from '~~/server/utils/db'
import { getServerConfig } from '~~/server/utils/config'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  if (countBoards() <= 1) throw createError({ statusCode: 409, statusMessage: 'The last board cannot be deleted.' })
  const result = deleteBoard(id)
  if (!result) throw createError({ statusCode: 404, statusMessage: 'Board not found.' })

  // The rows are gone either way; a leftover folder is preferable to failing the request.
  const root = resolve(getServerConfig().attachmentsPath)
  await Promise.all(result.ticketIds.map(ticketId => rm(join(root, ticketId), { recursive: true, force: true }).catch(() => undefined)))

  setResponseStatus(event, 204)
  return null
})
