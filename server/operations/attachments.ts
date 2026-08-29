import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { z } from 'zod'
import { addAttachment, findAttachment } from '../utils/db'
import {
  AttachmentPolicyError,
  MAX_ATTACHMENT_BASE64_LENGTH,
  validateManualAttachment
} from '../utils/attachment-policy'
import { getServerConfig } from '../utils/config'
import { createdId, defineOperation } from './types'
import { orNotFound } from './run'

const attachmentId = z.string().trim().min(1).max(64)

/**
 * What is known about one attachment, reached by its own id.
 *
 * The bytes are deliberately not here. `run` answers three surfaces with JSON, and a file is
 * a transport concern — so this returns the record and leaves the streaming to whoever asked.
 * What it does own is the check: an attachment id names a file directly, with no board and no
 * ticket in the request, so the ticket it hangs on has to be resolved and authorised first.
 */
export const attachmentGet = defineOperation({
  name: 'attachment.get',
  summary: 'Read what is known about one attachment',
  input: z.object({ attachmentId }),
  requires: {
    scope: 'ticket',
    role: 'viewer',
    // Resolved in `requires`, so the access check lands on the ticket owning the file rather
    // than on anything the caller named. An unknown id answers 404 before a board is read.
    ticketId: input => orNotFound(findAttachment(input.attachmentId), 'Attachment').ticket_id
  },
  audit: false,
  run: (_ctx, input) => ({ attachment: orNotFound(findAttachment(input.attachmentId), 'Attachment') })
})

/**
 * Attach a file to a ticket, carried as base64 in the JSON body.
 *
 * Base64 rather than multipart because this is the only shape that fits the core as it
 * stands: an operation takes validated JSON, and `run` is the single place a write is
 * audited and announced. A multipart body would have to come in past all of that. The cost
 * is a third more bytes on the wire, which for a screenshot or a small PDF is nothing worth
 * building a second request path for.
 *
 * The file itself is written here rather than by the caller, so the row and the bytes cannot
 * exist without one another — the write below is undone if the row fails.
 */
export const attachmentAdd = defineOperation({
  name: 'attachment.add',
  summary: 'Attach a file to a ticket',
  input: z.object({
    ticketId: z.string().trim().min(1).max(64),
    filename: z.string().trim().min(1).max(180)
      .describe('With its extension — the extension decides which types are allowed.'),
    content: z.base64().max(MAX_ATTACHMENT_BASE64_LENGTH)
      .describe('The file itself, base64-encoded. Up to 25 MB once decoded.'),
    mimeType: z.string().trim().max(255).optional()
      .describe('Optional. Checked against the extension and against the file’s own signature.')
  }),
  requires: { scope: 'ticket', role: 'editor', ticketId: input => input.ticketId },
  // `content` is deliberately absent from the allowlist. A 20 MB file has no business in the
  // audit log, and the allowlist is what keeps it out by construction rather than by anyone
  // remembering to leave it off.
  audit: { targetType: 'attachment', targetId: createdId('attachment'), changes: ['filename', 'mimeType'] },
  run: async (ctx, input) => {
    const ticket = ctx.ticket!
    // The same two rules the web upload holds to: an imported ticket belongs to its import,
    // and an archived one has left the board.
    if (ticket.source !== 'manual') {
      throw createError({ statusCode: 403, statusMessage: 'Attachments can only be added to manual tickets.' })
    }
    if (ticket.archivedAt) {
      throw createError({ statusCode: 409, statusMessage: 'Attachments cannot be added to archived tickets.' })
    }

    const data = Buffer.from(input.content, 'base64')
    let file: ReturnType<typeof validateManualAttachment>
    try {
      // The same policy the browser upload goes through — extension allowlist, size, and the
      // file's own magic bytes. Decoding is lenient, so a body that was never base64 arrives
      // here as noise and is caught by the signature check rather than trusted.
      file = validateManualAttachment({ filename: input.filename, mimeType: input.mimeType, data })
    } catch (error) {
      if (error instanceof AttachmentPolicyError) throw createError({ statusCode: 422, statusMessage: error.message })
      throw error
    }

    const directory = join(resolve(getServerConfig().attachmentsPath), ticket.id)
    await mkdir(directory, { recursive: true })
    const storedName = `${randomUUID()}${file.extension}`
    const path = join(directory, storedName)
    // `wx` so a name collision fails rather than overwrites, however unlikely a UUID clash is.
    await writeFile(path, data, { flag: 'wx', mode: 0o600 })

    try {
      const id = addAttachment(ticket.id, 'file', file.filename, file.mimeType, data.length, join(ticket.id, storedName))
      return {
        attachment: {
          id,
          kind: 'file' as const,
          filename: file.filename,
          mimeType: file.mimeType,
          size: data.length,
          url: `/api/v1/attachments/${id}`
        }
      }
    } catch (error) {
      // The row is what makes the file reachable. Without it the bytes are litter nobody
      // will ever look for, so they go back out the way they came in.
      await unlink(path).catch(() => undefined)
      throw error
    }
  }
})
