import { run } from '~~/server/operations'
import * as ops from '~~/server/operations'
import { MAX_ATTACHMENT_SIZE } from '~~/server/utils/attachment-policy'
import { writeAudit } from '~~/server/utils/audit'
import { sendProblem, toProblem } from '~~/server/utils/problem'
import { actorForUploadSlot, claimUploadSlot, findOpenUploadSlot } from '~~/server/utils/upload-slot'

/** Room for the multipart framing around one file at the size limit. */
const MAX_BODY = MAX_ATTACHMENT_SIZE + 1024 * 1024

/**
 * Where a one-time upload address from `attachment.uploadUrl` is spent.
 *
 * Signed in by nothing but the secret in the path, which is why the auth middleware lets it
 * through: the agent posting here holds no token, by design. The slot is checked before the
 * body is read, so an address that opens nothing costs the server no upload.
 */
export default defineEventHandler(async (event) => {
  const instance = `POST ${getRequestURL(event).pathname.replace(/[^/]+$/, '{secret}')}`
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  try {
    const slot = findOpenUploadSlot(getRouterParam(event, 'secret') || '')
    if (!slot) {
      // The same trace a bad token leaves: a run of these is somebody guessing.
      writeAudit({ operation: 'attachment.upload', targetType: 'upload', result: 'denied', channel: 'api', ip })
      throw createError({ statusCode: 404, statusMessage: 'This upload address is unknown, already used or expired.' })
    }

    const length = Number(getRequestHeader(event, 'content-length') || 0)
    if (length > MAX_BODY) throw createError({ statusCode: 413, statusMessage: 'The file is larger than 25 MB.' })

    if (!claimUploadSlot(slot.id)) {
      throw createError({ statusCode: 404, statusMessage: 'This upload address is unknown, already used or expired.' })
    }
    const actor = actorForUploadSlot(slot)
    if (!actor) throw createError({ statusCode: 403, statusMessage: 'The credential this address was issued for is no longer valid.' })

    const parts = await readMultipartFormData(event)
    const files = parts?.filter(part => part.name === 'file' && part.filename) || []
    if (files.length !== 1) {
      throw createError({ statusCode: 422, statusMessage: 'Send exactly one file, as the multipart field "file".' })
    }
    const [file] = files as [NonNullable<typeof files[number]>]
    if (file.data.length > MAX_ATTACHMENT_SIZE) throw createError({ statusCode: 413, statusMessage: 'The file is larger than 25 MB.' })

    // Everything from here is the ordinary upload, run as whoever asked for the address.
    // Base64 only to fit `attachment.add`'s JSON input; for 25 MB it is milliseconds.
    const result = await run(ops.attachmentAdd, actor, {
      ticketId: slot.ticketId,
      filename: slot.filename ?? file.filename,
      content: file.data.toString('base64'),
      mimeType: file.type
    }, { ip })
    setResponseStatus(event, 201)
    return result
  } catch (error) {
    return sendProblem(event, toProblem(error, instance))
  }
})
