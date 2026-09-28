import sharp from 'sharp'

/** Long enough to read a TestFlight screenshot, short enough not to eat a model's context. */
export const DEFAULT_PREVIEW_DIMENSION = 1500

/**
 * An image scaled down for a model to look at: at most `maxDimension` on its longer side,
 * never enlarged, and re-encoded as JPEG. A 2000 px PNG screenshot of half a megabyte comes
 * out at a fraction of that, which is what matters once it travels as base64.
 *
 * Transparency is flattened onto white, since JPEG has none and a transparent area would
 * otherwise turn black. The first frame stands in for an animated image. Returns null for a
 * file the library cannot decode (HEIC among them), so the caller can fall back to details.
 */
export async function imagePreview(path: string, maxDimension = DEFAULT_PREVIEW_DIMENSION): Promise<Buffer | null> {
  try {
    return await sharp(path, { animated: false })
      .rotate()
      .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer()
  } catch {
    return null
  }
}
