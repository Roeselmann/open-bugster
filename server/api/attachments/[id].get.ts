import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { findAttachment } from '~~/server/utils/db'
import { safeAttachmentName } from '~~/server/utils/app-store-connect'
import { getServerConfig } from '~~/server/utils/config'

export default defineEventHandler(async (event) => {
  const attachment = findAttachment(getRouterParam(event, 'id') || '')
  if (!attachment) throw createError({ statusCode: 404, statusMessage: 'Attachment not found.' })
  const config = getServerConfig()
  const root = await realpath(resolve(config.attachmentsPath)).catch(() => resolve(config.attachmentsPath))
  const candidate = resolve(root, attachment.relative_path)
  if (isAbsolute(attachment.relative_path) || (candidate !== root && !candidate.startsWith(`${root}${sep}`))) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid file path.' })
  }
  const actual = await realpath(candidate).catch(() => null)
  if (!actual || (actual !== root && !actual.startsWith(`${root}${sep}`))) throw createError({ statusCode: 404, statusMessage: 'File not found.' })
  await stat(actual).catch(() => { throw createError({ statusCode: 404, statusMessage: 'File not found.' }) })
  setHeader(event, 'Content-Type', attachment.mime_type)
  setHeader(event, 'Content-Length', attachment.size)
  const disposition = attachment.mime_type.startsWith('image/') ? 'inline' : 'attachment'
  setHeader(event, 'Content-Disposition', `${disposition}; filename="${safeAttachmentName(attachment.filename)}"`)
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  return sendStream(event, createReadStream(actual))
})
