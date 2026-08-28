import { setBoardPrivateKey } from '~~/server/utils/db'
import { boardViewer, requireBoardAccess } from '~~/server/utils/access'
import { MAX_PRIVATE_KEY_SIZE, PrivateKeyPolicyError, validatePrivateKey } from '~~/server/utils/private-key-policy'
import { SecretBoxError } from '~~/server/utils/secret-box'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  const { account } = requireBoardAccess(sessionActor(event), id, 'admin')

  const contentLength = Number(getRequestHeader(event, 'content-length') || 0)
  if (contentLength > MAX_PRIVATE_KEY_SIZE + 8 * 1024) throw createError({ statusCode: 413, statusMessage: 'The upload is too large to be a .p8 key.' })

  const parts = await readMultipartFormData(event)
  const file = parts?.find(part => part.name === 'key' && part.filename)
  if (!file) throw createError({ statusCode: 422, statusMessage: 'Please select a .p8 file.' })

  try {
    const { filename, pem } = await validatePrivateKey({ filename: file.filename!, data: file.data })
    return { board: setBoardPrivateKey(id, pem, filename, boardViewer(account)) }
  } catch (error) {
    if (error instanceof PrivateKeyPolicyError) throw createError({ statusCode: 422, statusMessage: error.message })
    if (error instanceof SecretBoxError) throw createError({ statusCode: 500, statusMessage: error.message })
    throw error
  }
})
