import { createHash } from 'node:crypto'
import { run } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'
import { findIdempotent, saveIdempotent } from '~~/server/utils/db'
import { buildOpenApiDocument } from '~~/server/utils/openapi'
import { sendProblem, toProblem } from '~~/server/utils/problem'
import { checkRateLimit } from '~~/server/utils/rate-limit'
import { createReadStream } from 'node:fs'
import type { H3Event } from 'h3'
import { safeAttachmentName } from '~~/server/utils/app-store-connect'
import { resolveAttachmentFile } from '~~/server/utils/attachment-file'
import { matchRoute } from './routes'
import { docsPage } from '~~/server/utils/docs-page'

/**
 * Everything under `/api/v1`, dispatched from the one route table that also produces the
 * OpenAPI document. A route cannot exist here and be missing from the spec, or the reverse.
 *
 * The two documentation paths are handled here rather than as their own files so that they
 * cannot be shadowed by a catch-all that Nitro happens to match first.
 */
export default defineEventHandler(async (event) => {
  const suffix = `/${(getRouterParam(event, 'path') || '').replace(/^\/+|\/+$/g, '')}`
  const method = event.method

  try {
    if (suffix === '/openapi.json') {
      return buildOpenApiDocument(new URL(getRequestURL(event)).origin)
    }
    if (suffix === '/docs') {
      setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
      return docsPage()
    }

    const actor = sessionActor(event)

    // Keyed on the credential where there is one, so one leaked token cannot spend the budget
    // of every other caller behind the same address.
    const limitKey = actor.tokenId || `principal:${actor.principalId}`
    const limit = checkRateLimit(limitKey)
    setResponseHeaders(event, {
      'X-RateLimit-Limit': String(limit.limit),
      'X-RateLimit-Remaining': String(limit.remaining),
      'X-RateLimit-Reset': String(limit.resetAt)
    })
    if (!limit.allowed) {
      // h3 types this header as a number, which is also what RFC 9110 wants here.
      setHeader(event, 'Retry-After', limit.retryAfter)
      throw createError({ statusCode: 429, statusMessage: 'Too many requests. Slow down and try again.' })
    }

    const matched = matchRoute(method, suffix)
    if (!matched) throw createError({ statusCode: 404, statusMessage: 'No such endpoint.' })
    const { route, params } = matched

    const body = method === 'GET' || method === 'DELETE' ? {} : (await readBody(event).catch(() => ({})) ?? {})
    const input = {
      ...route.defaults,
      ...coerceQuery(getQuery(event)),
      ...(typeof body === 'object' && body ? body : {}),
      // Last, so a path parameter can never be overridden by a body that disagrees with the URL.
      ...params
    }

    // A retry that reaches an already-completed request replays it rather than doing it twice.
    const idempotencyKey = getRequestHeader(event, 'idempotency-key')?.trim()
    const replayable = idempotencyKey && method !== 'GET'
    const fingerprint = replayable ? fingerprintOf(method, suffix, input) : ''
    if (replayable) {
      const previous = findIdempotent(idempotencyKey, actor.principalId)
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          throw createError({ statusCode: 409, statusMessage: 'This Idempotency-Key was already used for a different request.' })
        }
        setHeader(event, 'Idempotency-Replayed', 'true')
        setResponseStatus(event, previous.status)
        return previous.body ? JSON.parse(previous.body) : null
      }
    }

    const result = await run(route.operation, actor, input, {
      ip: getRequestIP(event, { xForwardedFor: true }) ?? null
    })

    // A download leaves the JSON convention here and nowhere earlier: the operation ran, the
    // access check passed, and only the shape of the answer differs. Nothing is recorded for
    // a replay either — an Idempotency-Key on a GET is ignored, as it is for every other read.
    if (route.download) return await sendAttachment(event, result)

    const status = route.status ?? 200
    const payload = status === 204 ? null : result
    if (replayable) {
      saveIdempotent(idempotencyKey, actor.principalId, {
        fingerprint,
        status,
        body: payload === null ? null : JSON.stringify(payload)
      })
    }
    setResponseStatus(event, status)
    return payload
  } catch (error) {
    return sendProblem(event, toProblem(error, `${method} /api/v1${suffix}`))
  }
})

/**
 * Streams the file an operation identified.
 *
 * Always `attachment`, never `inline`. The UI serves images for display because it renders
 * them in a lightbox on its own origin; a public endpoint handing back a browser-rendered
 * response is a different question, and answering it is not worth what a download API gains.
 */
async function sendAttachment(event: H3Event, result: unknown) {
  const { attachment } = result as { attachment: { filename: string; mime_type: string; size: number; relative_path: string } }
  const file = await resolveAttachmentFile(attachment.relative_path)
  setResponseHeaders(event, {
    'Content-Type': attachment.mime_type,
    'Content-Length': String(attachment.size),
    'Content-Disposition': `attachment; filename="${safeAttachmentName(attachment.filename)}"`,
    'X-Content-Type-Options': 'nosniff'
  })
  return sendStream(event, createReadStream(file))
}

/**
 * Query strings carry only text, and the schemas want the types they describe. This converts
 * the three shapes that actually appear — booleans, integers, and repeated keys — and leaves
 * anything else alone for zod to judge.
 */
function coerceQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(query)) {
    if (Array.isArray(raw)) { out[key] = raw; continue }
    const value = String(raw)
    if (value === 'true' || value === 'false') out[key] = value === 'true'
    else if (/^-?\d+$/.test(value)) out[key] = Number(value)
    else out[key] = value
  }
  return out
}

/** Two requests with the same key are the same request only if they ask for the same thing. */
function fingerprintOf(method: string, path: string, input: Record<string, unknown>): string {
  return createHash('sha256').update(`${method} ${path} ${stableStringify(input)}`).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}
