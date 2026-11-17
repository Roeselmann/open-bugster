import sharp from 'sharp'

/** Edge length of every stored portrait. Twice the largest avatar drawn, for sharp retina rendering. */
export const AVATAR_SIZE = 256
/** The upload as it arrives, base64 included. A cropped square from the browser is far below this. */
export const AVATAR_UPLOAD_LIMIT = 4 * 1024 * 1024

/**
 * Turns whatever the browser cropped into the one shape that is stored: a square JPEG of
 * `AVATAR_SIZE`, centre-cropped if it was not square after all.
 *
 * Re-encoding is the point, not a side effect. It drops every bit of metadata a phone photo
 * carries (the location among it), and it means nothing but a decoded-and-redrawn image is ever
 * served back from this instance. Null for anything that does not decode as an image.
 */
export async function normaliseAvatar(dataUrl: string): Promise<Buffer | null> {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) return null
  try {
    return await sharp(Buffer.from(match[2]!, 'base64'), { animated: false })
      .rotate()
      .resize({ width: AVATAR_SIZE, height: AVATAR_SIZE, fit: 'cover', position: 'centre' })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer()
  } catch {
    return null
  }
}
