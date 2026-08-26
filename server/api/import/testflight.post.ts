import { AppleApiError, syncTestFlight } from '~~/server/utils/app-store-connect'
import { getServerConfig } from '~~/server/utils/config'

export default defineEventHandler(async (event) => {
  const config = getServerConfig()
  try {
    const run = await syncTestFlight({
      issuerId: config.ascIssuerId,
      keyId: config.ascKeyId,
      appId: config.ascAppId,
      privateKeyPath: config.ascPrivateKeyPath,
      attachmentsPath: config.attachmentsPath
    })
    return { run }
  } catch (error) {
    if (error instanceof AppleApiError) throw createError({ statusCode: error.statusCode, statusMessage: error.message })
    throw createError({ statusCode: 500, statusMessage: error instanceof Error ? error.message : 'TestFlight sync failed.' })
  }
})
