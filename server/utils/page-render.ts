import type { Browser, BrowserContext } from 'playwright-core'
import sharp from 'sharp'
import { assertDeliverable } from './webhook'

/** The window a page is rendered in: a laptop screen, which is what most pages are designed for. */
const VIEWPORT = { width: 1280, height: 720 }
/** The card's thumbnail, the same 16:9 as the window, twice the size it is shown at. */
const THUMBNAIL = { width: 640, height: 360 }
/** Renders running at once. Each one is a browser tab, and a tab can take a few hundred MB. */
const MAX_PARALLEL = 2
/** The browser is closed again after this long without a render, and its memory with it. */
const IDLE_MS = 60_000
/** After a failed start, how long the server goes without trying again. */
const RETRY_MS = 10 * 60_000
const NAVIGATION_TIMEOUT_MS = 15_000
// The browser's own user agent says "HeadlessChrome", which some sites answer with a bot wall.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/**
 * Consent banners of the common consent platforms. A screenshot is taken without anybody
 * having answered one, so it would otherwise show the banner rather than the page. Hidden
 * rather than clicked away: nothing is agreed to on anybody's behalf.
 */
const CONSENT_BANNERS = [
  '#onetrust-consent-sdk', '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay', '#usercentrics-root', '#usercentrics-cmp-ui',
  '#cmpbox', '#cmpbox2', '.cc-window', '.cc-banner', '#cookie-notice', '.cookie-notice', '#cookie-law-info-bar', '.cky-consent-container',
  '.cky-overlay', '#BorlabsCookieBox', '#borlabs-cookie', '.cmplz-cookiebanner', '#didomi-host', '.qc-cmp2-container',
  '[id^="sp_message_container"]', '#truste-consent-track', '.fc-consent-root', '#gdpr-cookie-message', '.klaro', '#klaro',
  '#cookiescript_injected', '.cookie-consent', '#cookie-consent', '#consent-banner', '.consent-banner', '#cookieConsent',
  // CCM19, common on German sites; its root also holds the dimmed overlay and the floating button.
  '.ccm-root', '#ccm-widget'
].join(', ')

export function renderingEnabled(): boolean {
  return process.env.LINK_PREVIEW_RENDER !== 'false'
}

let browser: Promise<Browser> | null = null
let unavailableUntil = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null
let running = 0
const waiting: Array<() => void> = []

/**
 * One browser for the whole server, started on the first render rather than at boot: most
 * instances go hours without a new link, and an idle Chromium is memory nobody uses.
 * Playwright's own default leaves Chromium's sandbox off, which is also what a container
 * without extra privileges needs; the request screening below is what keeps a page in check.
 */
async function sharedBrowser(): Promise<Browser | null> {
  if (Date.now() < unavailableUntil) return null
  if (!browser) {
    browser = import('playwright-core')
      .then(({ chromium }) => chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--mute-audio', '--no-first-run', '--disable-gpu'] }))
    browser.then(started => started.on('disconnected', () => { browser = null }), () => undefined)
  }
  try {
    return await browser
  } catch (error) {
    browser = null
    unavailableUntil = Date.now() + RETRY_MS
    console.warn('[open-bugster] link previews fall back to page images: the browser could not be started.', (error as Error).message.split('\n')[0])
    return null
  }
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(async () => {
    if (running) return scheduleIdleClose()
    const current = browser
    browser = null
    await current?.then(started => started.close()).catch(() => undefined)
  }, IDLE_MS)
  idleTimer.unref?.()
}

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>(resolve => waiting.push(resolve))
  running++
  try {
    return await work()
  } finally {
    running--
    waiting.shift()?.()
    scheduleIdleClose()
  }
}

/**
 * Every request the page makes is screened exactly like the address itself — the document,
 * each redirect, every script, image, frame and fetch. A page is somebody else's code: left
 * alone it could point the browser at the cloud metadata service or at the internal network
 * and have the result photographed. Answers are remembered per host for the one render.
 */
async function guard(context: BrowserContext, onBlocked?: (url: string) => void) {
  const verdicts = new Map<string, Promise<boolean>>()
  const allowed = (url: string) => {
    let key: string
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return Promise.resolve(true)
      key = `${parsed.protocol}//${parsed.host}`
    } catch {
      return Promise.resolve(false)
    }
    let verdict = verdicts.get(key)
    if (!verdict) {
      verdict = assertDeliverable(url).then(() => true, () => false)
      verdicts.set(key, verdict)
    }
    return verdict
  }
  await context.route('**/*', async (route) => {
    const url = route.request().url()
    if (await allowed(url)) return route.continue().catch(() => undefined)
    onBlocked?.(url)
    return route.abort('blockedbyclient').catch(() => undefined)
  })
  // A screenshot needs no live connection, and a socket would slip past the routing above.
  await context.routeWebSocket(/.*/, (socket) => {
    onBlocked?.(socket.url())
    socket.close()
  })
}

/**
 * What the page behind a link looks like: its first screen, as a 640×360 JPEG. Null when the
 * page could not be shown — rendering switched off, no browser on this machine, the address
 * refused, or the page not loading in time — and the caller falls back to the page's images.
 *
 * `onBlocked` hears every request the screening refused; the tests use it.
 */
export async function renderPageThumbnail(rawUrl: string, onBlocked?: (url: string) => void): Promise<Buffer | null> {
  if (!renderingEnabled()) return null
  try {
    await assertDeliverable(rawUrl)
  } catch {
    return null
  }
  return slot(async () => {
    const started = await sharedBrowser()
    if (!started) return null
    let context: BrowserContext | null = null
    try {
      context = await started.newContext({
        viewport: VIEWPORT,
        userAgent: USER_AGENT,
        locale: 'de-DE',
        serviceWorkers: 'block',
        acceptDownloads: false,
        reducedMotion: 'reduce'
      })
      await guard(context, onBlocked)
      const page = await context.newPage()
      // Pop-ups and dialogs would only stall the render. Registered after the page itself, so
      // every page opened from here on is one the page opened.
      context.on('page', opened => opened.close().catch(() => undefined))
      page.on('dialog', dialog => dialog.dismiss().catch(() => undefined))
      const response = await page.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
      if (!response || response.status() >= 400) return null
      await page.waitForLoadState('load', { timeout: 8_000 }).catch(() => undefined)
      await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined)
      await page.addStyleTag({ content: `${CONSENT_BANNERS} { display: none !important; } html, body { overflow: auto !important; }` }).catch(() => undefined)
      // Fonts and entrance animations settle; reduced motion already cuts most of them short.
      await page.waitForTimeout(500)
      const shot = await page.screenshot({ type: 'png', timeout: 5_000 })
      return await sharp(shot).resize(THUMBNAIL).jpeg({ quality: 80, mozjpeg: true }).toBuffer()
    } catch {
      return null
    } finally {
      await context?.close().catch(() => undefined)
    }
  })
}
