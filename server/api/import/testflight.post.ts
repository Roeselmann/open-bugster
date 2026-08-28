import { AppleApiError, syncTestFlight } from '~~/server/utils/app-store-connect'
import { boardSyncCredentials, importLaneFor } from '~~/server/utils/db'
import { requireBoardAccess } from '~~/server/utils/access'
import { getServerConfig } from '~~/server/utils/config'
import { SecretBoxError } from '~~/server/utils/secret-box'
import { importRequestSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const parsed = importRequestSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const { boardId } = parsed.data
  requireBoardAccess(event, boardId, 'editor')

  const importLane = importLaneFor(boardId)
  if (!importLane) throw createError({ statusCode: 409, statusMessage: 'This board has no import lane.' })

  try {
    const credentials = boardSyncCredentials(boardId)!
    const run = await syncTestFlight({
      boardId,
      laneId: importLane.id,
      issuerId: credentials.issuerId,
      keyId: credentials.keyId,
      appId: credentials.appId,
      privateKeyPem: credentials.privateKeyPem,
      syncLimit: credentials.syncLimit,
      attachmentsPath: getServerConfig().attachmentsPath
    })
    return { run }
  } catch (error) {
    if (error instanceof AppleApiError) throw createError({ statusCode: error.statusCode, statusMessage: error.message })
    if (error instanceof SecretBoxError) throw createError({ statusCode: 500, statusMessage: error.message })
    throw createError({ statusCode: 500, statusMessage: error instanceof Error ? error.message : 'TestFlight sync failed.' })
  }
})
