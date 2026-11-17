import sharp from 'sharp'

/** Edge length of every stored portrait. Twice the largest avatar drawn, for sharp retina rendering. */
export const AVATAR_SIZE = 256
/** The longer side the original is kept at. Plenty to re-cut from, small enough for a row. */
export const ORIGINAL_MAX = 2048
/** The upload as it arrives, base64 included. A phone photo of several megabytes fits. */
export const AVATAR_UPLOAD_LIMIT = 30 * 1024 * 1024

/**
 * Decodes an upload into the original that is kept: turned upright by its orientation tag,
 * scaled down to `ORIGINAL_MAX`, re-encoded as JPEG.
 *
 * Re-encoding is the point, not a side effect. It drops every bit of metadata a phone photo
 * carries (the location among it), and it means nothing but a decoded-and-redrawn image is
 * ever stored or served. Null for anything that does not decode as a PNG, JPEG or WebP picture.
 */
export async function normaliseOriginal(dataUrl: string): Promise<Buffer | null> {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) return null
  try {
    return await sharp(Buffer.from(match[2]!, 'base64'), { animated: false })
      .rotate()
      .resize({ width: ORIGINAL_MAX, height: ORIGINAL_MAX, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer()
  } catch {
    return null
  }
}

/**
 * Cuts the portrait out of an original: a square as large as its shorter side, placed along
 * the longer side by `position` — 0 at the left or top, 1 at the right or bottom. That is the
 * same circle the crop dialog shows, so what was chosen there is exactly what comes out.
 */
export async function cutPortrait(original: Buffer, position: number): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(original).metadata()
  const side = Math.min(width, height)
  const travel = Math.max(width, height) - side
  const offset = Math.round(Math.min(1, Math.max(0, position)) * travel)
  return sharp(original)
    .extract({ left: width > height ? offset : 0, top: width > height ? 0 : offset, width: side, height: side })
    .resize(AVATAR_SIZE, AVATAR_SIZE)
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer()
}
