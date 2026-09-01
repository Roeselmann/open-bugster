import { basename } from 'node:path'
import { assertDeliverable, WebhookUrlError } from './webhook'
import { extensionForMime, hasAllowedExtension, MAX_ATTACHMENT_SIZE } from './attachment-policy'

export class AttachmentFetchError extends Error {}

/**
 * Downloads a file so a caller can hand over a URL instead of pushing megabytes of base64
 * through a request — or, for an agent, through a model's context.
 *
 * The destination is screened exactly like a webhook target (`assertDeliverable`): link-local
 * is always refused, private ranges obey `WEBHOOK_ALLOW_PRIVATE`. Redirects are refused
 * outright — every hop would need the address screening again, and refusing them keeps the
 * check and the fetch aimed at the same host. The body is read with a running cap rather than
 * buffered first, so a response that lies about its length cannot balloon past the limit.
 *
 * Every error thrown here is written for the caller's eyes — an MCP client sees the message
 * verbatim, so it never carries a resolved address or an internal failure detail.
 */
export async function fetchAttachmentSource(rawUrl: string, filename?: string): Promise<{ filename: string; mimeType?: string; data: Buffer }> {
  let url: URL
  try {
    url = await assertDeliverable(rawUrl)
  } catch (error) {
    if (error instanceof WebhookUrlError) throw new AttachmentFetchError(error.message)
    throw error
  }

  let response: Response
  try {
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
  } catch {
    throw new AttachmentFetchError('The URL could not be fetched.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new AttachmentFetchError(`The URL answered ${response.status}.`)
  }
  if (Number(response.headers.get('content-length') || 0) > MAX_ATTACHMENT_SIZE) {
    await response.body?.cancel().catch(() => undefined)
    throw new AttachmentFetchError('The file is larger than 25 MB.')
  }

  const data = await readCapped(response)

  const contentType = response.headers.get('content-type') || undefined
  let name = filename?.trim() || pathFilename(url) || 'attachment'
  // A URL like .../file/photos/12345 names nothing the policy can judge; the response's own
  // content type supplies the extension then, and the normal validation still runs after.
  if (!hasAllowedExtension(name)) {
    const extension = extensionForMime(contentType)
    if (extension) name = `${name}${extension}`
  }
  return { filename: name, mimeType: contentType, data }
}

function pathFilename(url: URL): string {
  const raw = basename(url.pathname)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

async function readCapped(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_ATTACHMENT_SIZE) {
        await reader.cancel().catch(() => undefined)
        throw new AttachmentFetchError('The file is larger than 25 MB.')
      }
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    if (error instanceof AttachmentFetchError) throw error
    throw new AttachmentFetchError('The download broke off before the file was complete.')
  }
  return Buffer.concat(chunks)
}
