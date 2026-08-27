import { AppleApiError, verifyTestFlightAccess } from '~~/server/utils/app-store-connect'
import { boardSyncCredentials, findBoard } from '~~/server/utils/db'
import { SecretBoxError } from '~~/server/utils/secret-box'
import { connectionTestSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  if (!findBoard(id)) throw createError({ statusCode: 404, statusMessage: 'Board not found.' })

  const parsed = connectionTestSchema.safeParse(await readBody(event).catch(() => ({})) || {})
  if (!parsed.success) throw validationError(parsed.error)

  // The settings form may hold edits that were never saved, and testing the stored values
  // instead would answer a question nobody asked. Only the private key has to come from the
  // vault, because it is write-only and never leaves the server.
  const stored = boardSyncCredentials(id)!
  const credentials = {
    ...stored,
    issuerId: parsed.data.issuerId ?? stored.issuerId,
    keyId: parsed.data.keyId ?? stored.keyId,
    appId: parsed.data.appId ?? stored.appId,
  }

  try {
    return { app: await verifyTestFlightAccess(credentials) }
  } catch (error) {
    if (error instanceof AppleApiError) throw createError({ statusCode: error.statusCode, statusMessage: error.message })
    if (error instanceof SecretBoxError) throw createError({ statusCode: 500, statusMessage: error.message })
    throw createError({ statusCode: 500, statusMessage: error instanceof Error ? error.message : 'The connection test failed.' })
  }
})
