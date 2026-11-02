import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { parsePageMetadata, readLinkPreview } from '../server/utils/link-preview'

const page = new URL('https://203.0.113.10/docs/page')
/** These tests are about reading pages; rendering them has tests of its own. */
const noBrowser = async () => null

describe('link previews', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('prefers Open Graph, then Twitter cards, then plain HTML', () => {
    const html = `<html><head>
      <title>Plain &amp; simple</title>
      <meta name="description" content="Plain description">
      <meta property="og:title" content="The &quot;real&quot; title">
      <meta name="twitter:description" content='Card description'>
      <meta content="Example Site" property="og:site_name">
      <meta property="og:image" content="/images/cover.png">
    </head><body><meta property="og:title" content="Ignored, in the body"></body></html>`
    expect(parsePageMetadata(html, page)).toEqual({
      title: 'The "real" title',
      description: 'Card description',
      siteName: 'Example Site',
      image: 'https://203.0.113.10/images/cover.png',
      contentImages: []
    })
    expect(parsePageMetadata('<title>\n  Only a   title </title>', page)).toEqual({ title: 'Only a title', description: null, siteName: null, image: null, contentImages: [] })
  })

  it('collects photos from the content, leaving out logos, icons, SVGs and small pictures', () => {
    const html = `<head><title>Holiday flat</title></head><body>
      <img src="/images/house-logo.png" alt="House">
      <img src="/images/partner.svg" alt="Partner">
      <img src="/img/a.jpg" alt="Navigation" class="icon">
      <img src="/img/thumb.jpg" width="80">
      <img src="data:image/gif;base64,R0lGOD">
      <img src="/images/summer.avif" alt="The house in summer">
      <img data-src="/images/winter.jpg" src="/blank.gif" alt="The house in winter">
      <img src="/images/summer.avif" alt="Again">
    </body>`
    expect(parsePageMetadata(html, page).contentImages).toEqual([
      'https://203.0.113.10/images/summer.avif',
      'https://203.0.113.10/images/winter.jpg'
    ])
  })

  it('takes photos from the content of a page, never from its menus', () => {
    const teaser = '<img src="/teaser/summit.jpg" alt="Summit" width="400">'
    // A mega menu in the header advertises other pages; the content is in <main>.
    expect(parsePageMetadata(`<body><header><nav>${teaser}</nav></header><main><p>Text only.</p></main><footer>${teaser}</footer></body>`, page).contentImages).toEqual([])
    expect(parsePageMetadata(`<body><header>${teaser}</header><main><img src="/hero.jpg"></main></body>`, page).contentImages).toEqual(['https://203.0.113.10/hero.jpg'])
    // Without <main>, the body minus header, navigation, footer and sidebars.
    expect(parsePageMetadata(`<body><nav>${teaser}</nav><div><img src="/hero.jpg"></div><aside>${teaser}</aside></body>`, page).contentImages).toEqual(['https://203.0.113.10/hero.jpg'])
  })

  it('refuses an image address that is no web address', () => {
    expect(parsePageMetadata('<meta property="og:image" content="javascript:alert(1)">', page).image).toBeNull()
  })

  // An address literal from the documentation range: screened like any host, resolved by nobody.
  it('follows a redirect, reads the page and turns its image into a thumbnail', async () => {
    const png = await sharp({ create: { width: 1200, height: 630, channels: 3, background: '#3366ff' } }).png().toBuffer()
    const fetchMock = vi.fn(async (url: URL) => {
      const href = url.toString()
      if (href === 'https://203.0.113.10/short') return new Response(null, { status: 301, headers: { location: '/docs/page' } })
      if (href === 'https://203.0.113.10/docs/page') {
        return new Response('<head><meta property="og:title" content="Docs"><meta property="og:image" content="https://203.0.113.10/cover.png"></head>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (href === 'https://203.0.113.10/cover.png') return new Response(png, { headers: { 'content-type': 'image/png' } })
      return new Response('missing', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await readLinkPreview('https://203.0.113.10/short', noBrowser)
    expect(result.title).toBe('Docs')
    const thumbnail = await sharp(result.thumbnail!).metadata()
    // Cropped to the card's 16:9, at twice the size it is shown.
    expect([thumbnail.format, thumbnail.width, thumbnail.height]).toEqual(['jpeg', 640, 360])
  })

  it('falls back to the first photo in the content that is big enough to be one', async () => {
    const banner = await sharp({ create: { width: 1600, height: 200, channels: 3, background: '#000' } }).png().toBuffer()
    const photo = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#2a7' } }).jpeg().toBuffer()
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      const href = url.toString()
      if (href === 'https://203.0.113.10/') {
        return new Response('<head><title>Flat</title></head><body><img src="/banner.png"><img src="/photo.jpg"></body>', { headers: { 'content-type': 'text/html' } })
      }
      if (href === 'https://203.0.113.10/banner.png') return new Response(banner, { headers: { 'content-type': 'image/png' } })
      if (href === 'https://203.0.113.10/photo.jpg') return new Response(photo, { headers: { 'content-type': 'image/jpeg' } })
      return new Response('missing', { status: 404 })
    }))
    const result = await readLinkPreview('https://203.0.113.10/', noBrowser)
    // The banner is too stretched to be a photo; the photo after it is taken.
    const { width, height } = await sharp(result.thumbnail!).metadata()
    expect([width, height]).toEqual([640, 360])
    const { dominant } = await sharp(result.thumbnail!).stats()
    expect(dominant.g).toBeGreaterThan(dominant.r)
  })

  it('answers a page that cannot be read with an empty preview rather than an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    expect(await readLinkPreview('https://203.0.113.10/broken', noBrowser)).toEqual({ title: null, description: null, siteName: null, thumbnail: null })
    // An SVG is never rendered: it is a document, not a picture.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } })))
    expect((await readLinkPreview('https://203.0.113.10/logo.svg', noBrowser)).thumbnail).toBeNull()
  })
})
