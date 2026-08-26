import { basename, extname } from 'node:path'

export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024
export const MAX_ATTACHMENT_COUNT = 10
export const MAX_ATTACHMENT_BATCH_SIZE = 100 * 1024 * 1024

type AttachmentRule = {
  mimeTypes: string[]
  canonicalMimeType: string
  image?: boolean
  signature?: (data: Buffer) => boolean
}

const startsWith = (data: Buffer, bytes: number[]) => data.length >= bytes.length && bytes.every((byte, index) => data[index] === byte)
const ascii = (data: Buffer, start: number, end: number) => data.subarray(start, end).toString('ascii')

const rules: Record<string, AttachmentRule> = {
  '.jpg': { mimeTypes: ['image/jpeg'], canonicalMimeType: 'image/jpeg', image: true, signature: data => startsWith(data, [0xff, 0xd8, 0xff]) },
  '.jpeg': { mimeTypes: ['image/jpeg'], canonicalMimeType: 'image/jpeg', image: true, signature: data => startsWith(data, [0xff, 0xd8, 0xff]) },
  '.png': { mimeTypes: ['image/png'], canonicalMimeType: 'image/png', image: true, signature: data => startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  '.gif': { mimeTypes: ['image/gif'], canonicalMimeType: 'image/gif', image: true, signature: data => ['GIF87a', 'GIF89a'].includes(ascii(data, 0, 6)) },
  '.webp': { mimeTypes: ['image/webp'], canonicalMimeType: 'image/webp', image: true, signature: data => ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP' },
  '.heic': { mimeTypes: ['image/heic', 'image/heif'], canonicalMimeType: 'image/heic', image: true, signature: data => ascii(data, 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(ascii(data, 8, 12)) },
  '.pdf': { mimeTypes: ['application/pdf'], canonicalMimeType: 'application/pdf', signature: data => ascii(data, 0, 5) === '%PDF-' },
  '.txt': { mimeTypes: ['text/plain'], canonicalMimeType: 'text/plain' },
  '.log': { mimeTypes: ['text/plain'], canonicalMimeType: 'text/plain' },
  '.csv': { mimeTypes: ['text/csv', 'application/csv'], canonicalMimeType: 'text/csv' },
  '.json': { mimeTypes: ['application/json', 'text/json'], canonicalMimeType: 'application/json' },
  '.doc': { mimeTypes: ['application/msword'], canonicalMimeType: 'application/msword' },
  '.docx': { mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], canonicalMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.xls': { mimeTypes: ['application/vnd.ms-excel'], canonicalMimeType: 'application/vnd.ms-excel' },
  '.xlsx': { mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], canonicalMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.ppt': { mimeTypes: ['application/vnd.ms-powerpoint'], canonicalMimeType: 'application/vnd.ms-powerpoint' },
  '.pptx': { mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], canonicalMimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
}

export class AttachmentPolicyError extends Error {}

export function safeUploadFilename(value: string) {
  const cleaned = basename(value).replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (cleaned || 'attachment').slice(0, 180)
}

export function validateManualAttachment(input: { filename: string; mimeType?: string; data: Buffer }) {
  const filename = safeUploadFilename(input.filename)
  const extension = extname(filename).toLowerCase()
  const rule = rules[extension]
  if (!rule) throw new AttachmentPolicyError(`The file type of “${filename}” is not supported.`)
  if (!input.data.length) throw new AttachmentPolicyError(`“${filename}” is empty.`)
  if (input.data.length > MAX_ATTACHMENT_SIZE) throw new AttachmentPolicyError(`“${filename}” is larger than 25 MB.`)

  const suppliedMimeType = input.mimeType?.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream'
  if (suppliedMimeType !== 'application/octet-stream' && !rule.mimeTypes.includes(suppliedMimeType)) {
    throw new AttachmentPolicyError(`The file extension and content type of “${filename}” do not match.`)
  }
  if (rule.signature && !rule.signature(input.data)) {
    throw new AttachmentPolicyError(`“${filename}” does not contain a valid ${extension.slice(1).toUpperCase()} file.`)
  }

  return { filename, extension, mimeType: rule.canonicalMimeType, isImage: Boolean(rule.image) }
}
