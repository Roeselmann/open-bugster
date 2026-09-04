import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { importPKCS8, SignJWT } from 'jose'
import { addAttachment, createSyncRun, finishSyncRun, hasExternalTicket, insertImportedTicket, latestSyncRun } from './db'
import { computeImportCutoff, isWithinImportWindow, titleFromFeedback } from './import-policy'
import { acquireSyncLock } from './sync-lock'

const APPLE_API = 'https://api.appstoreconnect.apple.com'

type AppleResource = {
  id: string
  type: string
  attributes?: Record<string, unknown>
  relationships?: Record<string, { data?: { id: string; type: string } | null }>
}

type AppleList = {
  data: AppleResource[]
  included?: AppleResource[]
  links?: { next?: string }
}

export class AppleApiError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message)
  }
}

export async function createAppleToken(config: { issuerId: string; keyId: string; privateKeyPem: string }, now = Math.floor(Date.now() / 1000)) {
  try {
    const key = await importPKCS8(config.privateKeyPem, 'ES256')
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: config.keyId, typ: 'JWT' })
      .setIssuer(config.issuerId)
      .setAudience('appstoreconnect-v1')
      .setIssuedAt(now)
      .setExpirationTime(now + 19 * 60)
      .sign(key)
  } catch {
    throw new AppleApiError(503, 'The App Store Connect key could not be read or processed.')
  }
}

function appleError(status: number) {
  if (status === 401) return 'Apple rejected the credentials. Check the key ID, issuer ID, and .p8 key.'
  if (status === 403) return 'The Apple API key does not have the required role or access to this app.'
  if (status === 404) return 'The configured Apple app or feedback record was not found.'
  if (status === 429) return 'The App Store Connect rate limit has been reached. Try syncing again later.'
  return status >= 500 ? 'App Store Connect is temporarily unavailable.' : 'App Store Connect rejected the request.'
}

async function appleFetch<T>(url: string, token: string): Promise<T> {
  const parsed = new URL(url, APPLE_API)
  if (parsed.origin !== APPLE_API) throw new AppleApiError(502, 'Apple returned an invalid pagination link.')
  let response: Response
  try {
    response = await fetch(parsed, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  } catch {
    throw new AppleApiError(502, 'App Store Connect is currently unreachable.')
  }
  if (!response.ok) throw new AppleApiError(response.status, appleError(response.status))
  return await response.json() as T
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function relatedBuild(item: AppleResource, included: AppleResource[] = []) {
  const buildId = item.relationships?.build?.data?.id || null
  const build = buildId ? included.find(resource => resource.type === 'builds' && resource.id === buildId) : undefined
  return { id: buildId, version: text(build?.attributes?.version) }
}

async function saveRemoteScreenshot(ticketId: string, feedbackId: string, index: number, screenshot: Record<string, unknown>, attachmentsPath: string) {
  const url = text(screenshot.url)
  if (!url) return
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error('Insecure screenshot URL')
  const response = await fetch(parsed)
  if (!response.ok) throw new Error(`The screenshot could not be downloaded (${response.status}).`)
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > 25 * 1024 * 1024) throw new Error('The screenshot is larger than 25 MB.')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 25 * 1024 * 1024) throw new Error('The screenshot is larger than 25 MB.')
  const contentType = response.headers.get('content-type')?.split(';')[0] || 'image/png'
  const extension = contentType === 'image/jpeg' ? '.jpg' : contentType === 'image/heic' ? '.heic' : '.png'
  const directory = join(attachmentsPath, ticketId)
  await mkdir(directory, { recursive: true })
  const filename = `testflight-${feedbackId}-${index + 1}${extension}`
  await writeFile(join(directory, filename), bytes, { flag: 'wx' })
  addAttachment(ticketId, 'screenshot', filename, contentType, bytes.length, join(ticketId, filename))
}

async function saveCrashLog(ticketId: string, feedbackId: string, token: string, attachmentsPath: string) {
  const response = await appleFetch<{ data?: { attributes?: { logText?: string } } }>(`${APPLE_API}/v1/betaFeedbackCrashSubmissions/${encodeURIComponent(feedbackId)}/crashLog?fields[betaCrashLogs]=logText`, token)
  const logText = response.data?.attributes?.logText
  if (!logText) return
  const bytes = Buffer.from(logText, 'utf8')
  const directory = join(attachmentsPath, ticketId)
  await mkdir(directory, { recursive: true })
  const filename = `testflight-${feedbackId}.crash`
  await writeFile(join(directory, filename), bytes, { flag: 'wx' })
  addAttachment(ticketId, 'crashlog', filename, 'text/plain; charset=utf-8', bytes.length, join(ticketId, filename))
}

async function importType(params: {
  type: 'screenshot' | 'crash'
  boardId: string
  laneId: string
  appId: string
  token: string
  cutoff: Date
  limit: number
  autoAuthor: boolean
  importTypeId: string | null
  attachmentsPath: string
}) {
  const resource = params.type === 'screenshot' ? 'betaFeedbackScreenshotSubmissions' : 'betaFeedbackCrashSubmissions'
  const fields = 'createdDate,comment,email,deviceModel,osVersion,locale,buildBundleId,build' + (params.type === 'screenshot' ? ',screenshots' : ',crashLog')
  const pageSize = Math.min(200, Math.max(1, params.limit))
  let next: string | undefined = `${APPLE_API}/v1/apps/${encodeURIComponent(params.appId)}/${resource}?fields[${resource}]=${fields}&fields[builds]=version&include=build&limit=${pageSize}&sort=-createdDate`
  let imported = 0
  let skipped = 0
  let failed = 0
  let examined = 0
  let reachedCutoff = false

  // Apple returns newest first, so the scan stops at whichever comes first: a submission
  // older than the cutoff, or the configured number of most recent submissions.
  while (next && !reachedCutoff) {
    const page: AppleList = await appleFetch<AppleList>(next, params.token)
    for (const item of page.data) {
      if (examined >= params.limit) {
        reachedCutoff = true
        break
      }
      examined++
      const attributes = item.attributes || {}
      const createdDate = text(attributes.createdDate)
      if (!createdDate || !isWithinImportWindow(createdDate, params.cutoff)) {
        reachedCutoff = true
        break
      }
      if (hasExternalTicket(params.boardId, item.id)) {
        skipped++
        continue
      }
      const build = relatedBuild(item, page.included)
      const comment = text(attributes.comment)
      const deviceModel = text(attributes.deviceModel)
      try {
        const ticket = insertImportedTicket({
          boardId: params.boardId,
          laneId: params.laneId,
          externalId: item.id,
          type: params.type,
          title: titleFromFeedback(params.type, comment, deviceModel),
          comment,
          testerEmail: text(attributes.email),
          autoAuthor: params.autoAuthor,
          typeId: params.importTypeId,
          deviceModel,
          osVersion: text(attributes.osVersion),
          locale: text(attributes.locale),
          buildId: build.id,
          buildVersion: build.version,
          buildBundleId: text(attributes.buildBundleId),
          sourceCreatedAt: createdDate,
          raw: item
        })
        imported++
        try {
          if (params.type === 'screenshot') {
            const screenshots = Array.isArray(attributes.screenshots) ? attributes.screenshots as Array<Record<string, unknown>> : []
            for (let index = 0; index < screenshots.length; index++) {
              await saveRemoteScreenshot(ticket.id, item.id, index, screenshots[index]!, params.attachmentsPath)
            }
          } else {
            await saveCrashLog(ticket.id, item.id, params.token, params.attachmentsPath)
          }
        } catch {
          failed++
        }
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed: .*tickets\.external_id/.test(error.message)) skipped++
        else failed++
      }
    }
    next = page.links?.next
  }
  return { imported, skipped, failed }
}

export async function syncTestFlight(config: {
  boardId: string
  laneId: string
  issuerId: string
  keyId: string
  appId: string
  privateKeyPem: string | null
  syncLimit: number
  autoAuthor: boolean
  importTypeId: string | null
  attachmentsPath: string
}) {
  const release = acquireSyncLock(config.boardId, 'testflight')
  if (!release) throw new AppleApiError(409, 'A TestFlight sync is already in progress for this board.')
  if (!config.issuerId || !config.keyId || !config.appId || !config.privateKeyPem) {
    release()
    throw new AppleApiError(503, 'The App Store Connect configuration of this board is incomplete.')
  }
  const previous = latestSyncRun(config.boardId, 'testflight', true)
  const run = createSyncRun(config.boardId, 'testflight')
  let imported = 0
  let skipped = 0
  let failed = 0
  try {
    const token = await createAppleToken({ issuerId: config.issuerId, keyId: config.keyId, privateKeyPem: config.privateKeyPem })
    const cutoff = computeImportCutoff(previous?.startedAt || null)
    for (const type of ['screenshot', 'crash'] as const) {
      const result = await importType({
        type,
        boardId: config.boardId,
        laneId: config.laneId,
        appId: config.appId,
        token,
        cutoff,
        limit: config.syncLimit,
        autoAuthor: config.autoAuthor,
        importTypeId: config.importTypeId,
        attachmentsPath: config.attachmentsPath
      })
      imported += result.imported
      skipped += result.skipped
      failed += result.failed
    }
    return finishSyncRun(config.boardId, run.id, failed ? 'partial' : 'success', imported, skipped, failed, failed ? 'Some attachments or feedback records could not be imported.' : null)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown import error.'
    finishSyncRun(config.boardId, run.id, 'failed', imported, skipped, failed + 1, message)
    throw error
  } finally {
    release()
  }
}

/**
 * Verifies the credentials without importing anything: signs a token, resolves the app,
 * and confirms the key actually has access to it.
 */
export async function verifyTestFlightAccess(config: { issuerId: string; keyId: string; appId: string; privateKeyPem: string | null }) {
  if (!config.issuerId || !config.keyId || !config.appId || !config.privateKeyPem) {
    throw new AppleApiError(503, 'The App Store Connect configuration of this board is incomplete.')
  }
  const token = await createAppleToken({ issuerId: config.issuerId, keyId: config.keyId, privateKeyPem: config.privateKeyPem })
  const response = await appleFetch<{ data?: AppleResource }>(
    `${APPLE_API}/v1/apps/${encodeURIComponent(config.appId)}?fields[apps]=name,bundleId`,
    token
  )
  return {
    name: text(response.data?.attributes?.name),
    bundleId: text(response.data?.attributes?.bundleId)
  }
}

export function safeAttachmentName(name: string) {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function attachmentExtension(name: string) {
  return extname(name).toLowerCase()
}
