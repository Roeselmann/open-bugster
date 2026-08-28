import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { addAttachment, deleteAttachment, findTicket } from '~~/server/utils/db'
import { requireTicketAccess } from '~~/server/utils/access'
import {
  AttachmentPolicyError,
  MAX_ATTACHMENT_BATCH_SIZE,
  MAX_ATTACHMENT_COUNT,
  validateManualAttachment,
} from '~~/server/utils/attachment-policy'
import { getServerConfig } from '~~/server/utils/config'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  const { ticket } = requireTicketAccess(event, id, 'editor')
  if (ticket.source !== 'manual') throw createError({ statusCode: 403, statusMessage: 'Attachments can only be added to manual tickets.' })
  if (ticket.archivedAt) throw createError({ statusCode: 409, statusMessage: 'Attachments cannot be added to archived tickets.' })

  const contentLength = Number(getRequestHeader(event, 'content-length') || 0)
  if (contentLength > MAX_ATTACHMENT_BATCH_SIZE + 2 * 1024 * 1024) {
    throw createError({ statusCode: 413, statusMessage: 'The total upload is larger than 100 MB.' })
  }

  const parts = await readMultipartFormData(event)
  const files = parts?.filter(part => part.name === 'files' && part.filename) || []
  if (!files.length) throw createError({ statusCode: 422, statusMessage: 'Please select at least one file.' })
  if (files.length > MAX_ATTACHMENT_COUNT) throw createError({ statusCode: 413, statusMessage: 'A maximum of 10 files is allowed per upload.' })
  if (files.reduce((total, file) => total + file.data.length, 0) > MAX_ATTACHMENT_BATCH_SIZE) {
    throw createError({ statusCode: 413, statusMessage: 'The total upload is larger than 100 MB.' })
  }

  let validated: Array<ReturnType<typeof validateManualAttachment> & { data: Buffer }>
  try {
    validated = files.map(file => ({ ...validateManualAttachment({ filename: file.filename!, mimeType: file.type, data: file.data }), data: file.data }))
  } catch (error) {
    if (error instanceof AttachmentPolicyError) throw createError({ statusCode: 422, statusMessage: error.message })
    throw error
  }

  const root = resolve(getServerConfig().attachmentsPath)
  const directory = join(root, ticket.id)
  await mkdir(directory, { recursive: true })
  const stored: Array<{ id?: string; path: string }> = []
  try {
    for (const file of validated) {
      const storedName = `${randomUUID()}${file.extension}`
      const path = join(directory, storedName)
      stored.push({ path })
      await writeFile(path, file.data, { flag: 'wx', mode: 0o600 })
      stored.at(-1)!.id = addAttachment(ticket.id, 'file', file.filename, file.mimeType, file.data.length, join(ticket.id, storedName))
    }
  } catch (error) {
    await Promise.all(stored.map(async (item) => {
      if (item.id) deleteAttachment(item.id)
      await unlink(item.path).catch(() => undefined)
    }))
    throw createError({ statusCode: 500, statusMessage: 'The attachments could not be saved.', cause: error })
  }

  return { ticket: findTicket(ticket.id)! }
})
