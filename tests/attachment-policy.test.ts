import { describe, expect, it } from 'vitest'
import { AttachmentPolicyError, extensionForMime, hasAllowedExtension, safeUploadFilename, validateManualAttachment } from '../server/utils/attachment-policy'

describe('manual attachment policy', () => {
  it('accepts supported images only when their signature is valid', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    expect(validateManualAttachment({ filename: 'Screenshot.PNG', mimeType: 'image/png', data: png })).toMatchObject({
      extension: '.png',
      mimeType: 'image/png',
      isImage: true,
    })
    expect(() => validateManualAttachment({ filename: 'fake.png', mimeType: 'image/png', data: Buffer.from('<html>') })).toThrow(AttachmentPolicyError)
  })

  it('accepts documents and rejects unsafe or mismatched types', () => {
    expect(validateManualAttachment({ filename: 'note.txt', mimeType: 'text/plain', data: Buffer.from('Hello') })).toMatchObject({ mimeType: 'text/plain', isImage: false })
    expect(() => validateManualAttachment({ filename: 'code.svg', mimeType: 'image/svg+xml', data: Buffer.from('<svg/>') })).toThrow(/not supported/)
    expect(() => validateManualAttachment({ filename: 'note.txt', mimeType: 'text/html', data: Buffer.from('Hello') })).toThrow(/do not match/)
  })

  it('normalizes uploaded display names', () => {
    expect(safeUploadFilename('../../Report\u0000.pdf')).toBe('Report.pdf')
  })

  it('names extensionless downloads from their content type', () => {
    expect(extensionForMime('image/jpeg')).toBe('.jpg')
    expect(extensionForMime('application/pdf; charset=binary')).toBe('.pdf')
    // "Unspecified" and unknown both refuse to guess.
    expect(extensionForMime('application/octet-stream')).toBeNull()
    expect(extensionForMime('image/svg+xml')).toBeNull()
    expect(hasAllowedExtension('shot.png')).toBe(true)
    expect(hasAllowedExtension('file/12345')).toBe(false)
  })
})
