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
import { AttachmentFetchError, fetchAttachmentSource } from '../utils/attachment-fetch'
import { getServerConfig } from '../utils/config'
import { createdId, defineOperation } from './types'
import { orNotFound } from './run'
import type { Ticket } from '~~/shared/types/domain'

const attachmentId = z.string().trim().min(1).max(64)

/**
 * The same two rules the web upload holds to: an imported ticket belongs to its import, and
 * an archived one has left the board.
 */
function assertAttachable(ticket: Ticket) {
  if (ticket.source !== 'manual') {
    throw createError({ statusCode: 403, statusMessage: 'Attachments can only be added to manual tickets.' })
  }
  if (ticket.archivedAt) {
    throw createError({ statusCode: 409, statusMessage: 'Attachments cannot be added to archived tickets.' })
  }
}

/**
 * Validates the bytes and makes them a ticket attachment: policy check, file on disk, row in
 * the database. The file is written first and unlinked again if the row fails, so the two
 * cannot exist without one another.
 */
async function storeValidatedAttachment(ticketId: string, source: { filename: string; mimeType?: string; data: Buffer }) {
  let file: ReturnType<typeof validateManualAttachment>
  try {
    file = validateManualAttachment(source)
  } catch (error) {
    if (error instanceof AttachmentPolicyError) throw createError({ statusCode: 422, statusMessage: error.message })
    throw error
  }

  const directory = join(resolve(getServerConfig().attachmentsPath), ticketId)
  await mkdir(directory, { recursive: true })
  const storedName = `${randomUUID()}${file.extension}`
  const path = join(directory, storedName)
  // `wx` so a name collision fails rather than overwrites, however unlikely a UUID clash is.
  await writeFile(path, source.data, { flag: 'wx', mode: 0o600 })

  try {
    const id = addAttachment(ticketId, 'file', file.filename, file.mimeType, source.data.length, join(ticketId, storedName))
    return {
      id,
      kind: 'file' as const,
      filename: file.filename,
      mimeType: file.mimeType,
      size: source.data.length,
      url: `/api/v1/attachments/${id}`
    }
  } catch (error) {
    // The row is what makes the file reachable. Without it the bytes are litter nobody
    // will ever look for, so they go back out the way they came in.
    await unlink(path).catch(() => undefined)
    throw error
  }
}

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
    assertAttachable(ticket)
    // Decoding is lenient, so a body that was never base64 arrives as noise and is caught by
    // the policy's signature check rather than trusted.
    const data = Buffer.from(input.content, 'base64')
    return { attachment: await storeValidatedAttachment(ticket.id, { filename: input.filename, mimeType: input.mimeType, data }) }
  }
})

/**
 * The same write, fed by a download: the caller hands over a URL and the server fetches the
 * file itself. This is the shape an AI agent needs — bytes must never travel through a
 * model's context, a URL is a few tokens. The destination is screened and capped in
 * `fetchAttachmentSource`; everything after the download is `attachment.add` exactly.
 */
export const attachmentAddFromUrl = defineOperation({
  name: 'attachment.addFromUrl',
  summary: 'Attach a file to a ticket by downloading it from a URL',
  input: z.object({
    ticketId: z.string().trim().min(1).max(64),
    url: z.string().trim().min(1).max(2000)
      .describe('The http(s) URL the server downloads the file from. Up to 25 MB.'),
    filename: z.string().trim().min(1).max(180).optional()
      .describe('Overrides the name taken from the URL — the extension decides which types are allowed.')
  }),
  requires: { scope: 'ticket', role: 'editor', ticketId: input => input.ticketId },
  // The URL, unlike file content, is small and pure provenance — it belongs in the log.
  audit: { targetType: 'attachment', targetId: createdId('attachment'), changes: ['filename', 'url'] },
  run: async (ctx, input) => {
    const ticket = ctx.ticket!
    assertAttachable(ticket)
    let source: Awaited<ReturnType<typeof fetchAttachmentSource>>
    try {
      source = await fetchAttachmentSource(input.url, input.filename)
    } catch (error) {
      if (error instanceof AttachmentFetchError) throw createError({ statusCode: 422, statusMessage: error.message })
      throw error
    }
    return { attachment: await storeValidatedAttachment(ticket.id, source) }
  }
})
