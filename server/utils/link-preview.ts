import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { assertDeliverable } from './webhook'
import { getServerConfig } from './config'
import { findTicketLink, saveLinkPreview } from './db'
import { renderPageThumbnail } from './page-render'

/** Enough for the `<head>` of any page worth previewing; the body is never needed. */
const MAX_PAGE_BYTES = 768 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_REDIRECTS = 4
const TIMEOUT_MS = 8_000
/** The card's thumbnail: a 16:9 crop, twice the size it is shown at for sharp screens. */
const THUMBNAIL = { width: 640, height: 360 }
const RASTER_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif'])
/** How many pictures from a page's content are tried when it names no preview image. */
const MAX_CONTENT_IMAGES = 4
/** What a picture from the content needs to stand in for one: a photo, not a logo or a spacer. */
const CONTENT_IMAGE = { minWidth: 300, minHeight: 160, maxAspect: 3 }
// Names and classes that mark a picture as decoration rather than content.
const DECORATION = /logo|icon|avatar|sprite|badge|emoji|pixel|spacer|tracking|placeholder/i

export interface PageMetadata {
  title: string | null
  description: string | null
  siteName: string | null
  /** Absolute, resolved against the page it was found on. */
  image: string | null
  /** Pictures from the page's content, in order — tried when it names no image of its own. */
  contentImages: string[]
}

/**
 * Fetches a page or image for a link preview. Unlike an attachment download, redirects are
 * followed — a pasted link very often is one — but each hop is screened again exactly like
 * the first (`assertDeliverable`), so a redirect cannot reach anything the address itself
 * could not. Null for anything that fails: a preview is a nicety, never an error.
 */
async function fetchScreened(rawUrl: string, accept: string, maxBytes: number): Promise<{ url: URL; contentType: string; body: Buffer } | null> {
  let next = rawUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let url: URL
    try {
      url = await assertDeliverable(next)
    } catch {
      return null
    }
    let response: Response
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        // Some sites answer an anonymous client with a bot wall rather than their page.
        headers: { accept, 'user-agent': 'Mozilla/5.0 (compatible; OpenBugster link preview)' }
      })
    } catch {
      return null
    }
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => undefined)
      next = new URL(location, url).toString()
      continue
    }
    if (!response.ok || Number(response.headers.get('content-length') || 0) > maxBytes) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    const body = await readUpTo(response, maxBytes)
    return body ? { url, contentType: response.headers.get('content-type') || '', body } : null
  }
  return null
}

/** Reads at most `maxBytes`. A page is cut off there; for an image that would be broken, so null. */
async function readUpTo(response: Response, maxBytes: number): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      chunks.push(Buffer.from(value))
      if (total >= maxBytes) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  } catch {
    return null
  }
  return Buffer.concat(chunks)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' }

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : match
    }
    return ENTITIES[entity.toLowerCase()] ?? match
  })
}

function clean(value: string | undefined, max: number): string | null {
  const text = value ? decodeEntities(value).replace(/\s+/g, ' ').trim() : ''
  if (!text) return null
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function attributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const match of tag.matchAll(/([a-z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    found[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return found
}

/**
 * What a page says about itself: Open Graph first, then Twitter's cards, then plain HTML,
 * and for the picture finally the photos in its content.
 * Read with patterns rather than a parser — only a handful of tags in the head matter, and
 * a page that hides them from this is a page without a preview, nothing worse.
 */
export function parsePageMetadata(html: string, pageUrl: URL): PageMetadata {
  const bodyAt = html.search(/<body[\s>]/i)
  const head = bodyAt > 0 ? html.slice(0, bodyAt) : html
  const meta: Record<string, string> = {}
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = attributes(tag)
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase()
    if (key && attrs.content !== undefined && !(key in meta)) meta[key] = attrs.content
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]
  const imageSource = head.match(/<link\b[^>]*\brel=["']?image_src\b[^>]*>/i)?.[0]
  const rawImage = meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || meta.image
    || (imageSource ? attributes(imageSource).href : undefined)
  const image = rawImage ? webAddress(rawImage, pageUrl) : null

  // A page without a preview image very often still shows photos; the first few that are not
  // decoration are the fallback. Lazy loaders keep the real address in a data attribute.
  const contentImages: string[] = []
  for (const tag of contentRegion(html.slice(Math.max(bodyAt, 0))).match(/<img\b[^>]*>/gi) || []) {
    const attrs = attributes(tag)
    const source = attrs['data-src'] || attrs['data-lazy-src'] || attrs.src
    if (!source || /^data:/i.test(source) || /\.svg(?:[?#]|$)/i.test(source)) continue
    if (DECORATION.test(`${source} ${attrs.alt || ''} ${attrs.class || ''} ${attrs.id || ''}`)) continue
    // A picture that says it is small is skipped without asking for it.
    if (Number(attrs.width) && Number(attrs.width) < CONTENT_IMAGE.minWidth) continue
    const address = webAddress(source, pageUrl)
    if (address && address !== image && !contentImages.includes(address)) contentImages.push(address)
    if (contentImages.length >= MAX_CONTENT_IMAGES) break
  }
  return {
    title: clean(meta['og:title'] || meta['twitter:title'] || titleTag, 300),
    description: clean(meta['og:description'] || meta['twitter:description'] || meta.description, 500),
    siteName: clean(meta['og:site_name'] || meta['application-name'], 100),
    image,
    contentImages
  }
}

/**
 * The part of a page that is its own content. Menus are where a site keeps teasers for every
 * other page — a mega menu full of event photos would otherwise lend its first one to every
 * link. `<main>`, or an `<article>`, when the page marks it; otherwise the body without its
 * header, navigation, footer and sidebars.
 */
function contentRegion(body: string): string {
  const marked = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body)?.[1] ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(body)?.[1]
  if (marked !== undefined) return marked
  return body.replace(/<(header|nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
}

/** An http(s) address resolved against the page, or null for anything else. */
function webAddress(raw: string, pageUrl: URL): string | null {
  try {
    const resolved = new URL(decodeEntities(raw.trim()), pageUrl)
    return resolved.protocol === 'https:' || resolved.protocol === 'http:' ? resolved.toString() : null
  } catch {
    return null
  }
}

/** The page's own charset, from the header or the markup, so umlauts survive a Latin-1 site. */
function decodePage(body: Buffer, contentType: string): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
    || /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1]
  try {
    return new TextDecoder(declared || 'utf-8').decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body)
  }
}

/**
 * A raster image cropped to the card's thumbnail. Null for SVG and anything undecodable —
 * and, for a picture merely found in a page's content (`photoOnly`), for anything too small
 * or too stretched to be a photo rather than a logo or a banner.
 */
async function thumbnailOf(data: Buffer, photoOnly = false): Promise<Buffer | null> {
  try {
    const image = sharp(data, { animated: false, limitInputPixels: 50_000_000 })
    const { format, width = 0, height = 0, autoOrient } = await image.metadata()
    if (!format || !RASTER_FORMATS.has(format)) return null
    if (photoOnly) {
      const shown = autoOrient ?? { width, height }
      const aspect = shown.width / Math.max(shown.height, 1)
      if (shown.width < CONTENT_IMAGE.minWidth || shown.height < CONTENT_IMAGE.minHeight) return null
      if (aspect > CONTENT_IMAGE.maxAspect || aspect < 1 / CONTENT_IMAGE.maxAspect) return null
    }
    return await image
      .rotate()
      .resize({ ...THUMBNAIL, fit: 'cover', position: 'attention', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer()
  } catch {
    return null
  }
}

export interface LinkPreviewResult extends Omit<PageMetadata, 'image' | 'contentImages'> {
  thumbnail: Buffer | null
}

/**
 * Reads what a link leads to. The thumbnail is the page itself, rendered in a browser; the
 * picture the page names for previews, then the first photo of its content, stand in when it
 * cannot be rendered. A link straight to a picture is its own thumbnail.
 *
 * `render` is replaceable so the tests can run without a browser.
 */
export async function readLinkPreview(rawUrl: string, render: (url: string) => Promise<Buffer | null> = renderPageThumbnail): Promise<LinkPreviewResult> {
  const empty = { title: null, description: null, siteName: null, thumbnail: null }
  const page = await fetchScreened(rawUrl, 'text/html,application/xhtml+xml,image/*;q=0.8', MAX_IMAGE_BYTES)
  // A site may turn away a plain request and still show a browser its page.
  if (!page) return { ...empty, thumbnail: await render(rawUrl) }
  if (page.contentType.startsWith('image/')) return { ...empty, thumbnail: await thumbnailOf(page.body) }
  if (!/html|xml/i.test(page.contentType)) return empty
  const metadata = parsePageMetadata(decodePage(page.body.subarray(0, MAX_PAGE_BYTES), page.contentType), page.url)
  let thumbnail = await render(page.url.toString())
  if (!thumbnail && metadata.image) thumbnail = await imageThumbnail(metadata.image, false)
  // One after another, not all at once: the first usable photo ends the search.
  for (const address of metadata.contentImages) {
    if (thumbnail) break
    thumbnail = await imageThumbnail(address, true)
  }
  return { title: metadata.title, description: metadata.description, siteName: metadata.siteName, thumbnail }
}

async function imageThumbnail(address: string, photoOnly: boolean): Promise<Buffer | null> {
  const image = await fetchScreened(address, 'image/avif,image/webp,image/*', MAX_IMAGE_BYTES)
  return image?.contentType.startsWith('image/') ? thumbnailOf(image.body, photoOnly) : null
}

/** Removes thumbnails no row points at any more. Best effort: a leftover file harms nobody. */
export async function deleteLinkThumbnails(relativePaths: string[]) {
  const root = resolve(getServerConfig().attachmentsPath)
  await Promise.all(relativePaths.map(path => unlink(join(root, path)).catch(() => undefined)))
}

// Two people opening the same ticket at once ask for the same page only once.
const inFlight = new Map<string, Promise<void>>()

/**
 * Reads a link's page and stores what it said, replacing an earlier preview. The thumbnail
 * is written before the row points at it, and taken away again if the link was removed in
 * the meantime — so neither a row without its file nor a file without its row stays behind.
 */
export function refreshLinkPreview(linkId: string): Promise<void> {
  const running = inFlight.get(linkId)
  if (running) return running
  const job = (async () => {
    const link = findTicketLink(linkId)
    if (!link) return
    const result = await readLinkPreview(link.url)
    let imagePath: string | null = null
    if (result.thumbnail) {
      const directory = join(resolve(getServerConfig().attachmentsPath), link.ticketId)
      await mkdir(directory, { recursive: true })
      imagePath = join(link.ticketId, `link-${randomUUID()}.jpg`)
      await writeFile(join(resolve(getServerConfig().attachmentsPath), imagePath), result.thumbnail, { flag: 'wx', mode: 0o600 })
    }
    const saved = saveLinkPreview(linkId, { title: result.title, description: result.description, siteName: result.siteName, imagePath })
    const orphaned = saved ? [link.imagePath] : [imagePath]
    await deleteLinkThumbnails(orphaned.filter((path): path is string => Boolean(path)))
  })().finally(() => inFlight.delete(linkId))
  inFlight.set(linkId, job)
  return job
}
