import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import sharp from 'sharp'
import { renderPageThumbnail } from '../server/utils/page-render'

// Rendering needs Chromium on the machine (`npx playwright-core install chromium-headless-shell`);
// without it the renderer answers null and the page's own images stand in, which the
// link-preview tests cover.
const hasBrowser = await chromium.launch({ headless: true }).then(browser => browser.close().then(() => true), () => false)

describe.skipIf(!hasBrowser)('rendering a page for its thumbnail', () => {
  let server: Server
  let origin = ''
  let hits: string[] = []

  beforeAll(async () => {
    server = createServer((request, response) => {
      hits.push(request.url || '')
      if (request.url === '/page') {
        response.writeHead(200, { 'content-type': 'text/html' })
        // Green all over, and three attempts to reach what a page must never reach.
        response.end(`<!doctype html><html><body style="margin:0;background:#1f9d55">
          <h1 style="color:#fff;font:64px sans-serif">Rendered</h1>
          <img src="http://169.254.169.254/latest/meta-data/">
          <script>
            fetch('http://169.254.169.254/latest/meta-data/iam').catch(() => {})
            try { new WebSocket('ws://' + location.host + '/socket') } catch {}
          </script>
        </body></html>`)
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

  it('photographs the first screen and refuses every request to link-local addresses', async () => {
    hits = []
    const blocked: string[] = []
    const thumbnail = await renderPageThumbnail(`${origin}/page`, url => blocked.push(url))
    expect(thumbnail).not.toBeNull()
    const metadata = await sharp(thumbnail!).metadata()
    expect([metadata.format, metadata.width, metadata.height]).toEqual(['jpeg', 640, 360])
    const { dominant } = await sharp(thumbnail!).stats()
    expect(dominant.g).toBeGreaterThan(dominant.r + 40)

    expect(blocked).toContain('http://169.254.169.254/latest/meta-data/')
    expect(blocked).toContain('http://169.254.169.254/latest/meta-data/iam')
    // The socket never reached the server.
    expect(blocked.some(url => url.endsWith('/socket'))).toBe(true)
    expect(hits).toEqual(['/page'])
  }, 60_000)

  it('answers null for a page that does not load, and for an address that is refused', async () => {
    expect(await renderPageThumbnail(`${origin}/missing`)).toBeNull()
    expect(await renderPageThumbnail('http://169.254.169.254/latest/meta-data/')).toBeNull()
    expect(await renderPageThumbnail('file:///etc/passwd')).toBeNull()
  }, 60_000)
})
