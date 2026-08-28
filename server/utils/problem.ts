import type { H3Event } from 'h3'

/**
 * RFC 9457 `application/problem+json`.
 *
 * The internal API throws H3 errors and the UI reads `statusMessage`; a public API needs
 * something a generated client can branch on, so every error on `/api/v1` carries a stable
 * machine-readable `type` alongside the sentence a person would read.
 */
export interface Problem {
  type: string
  title: string
  status: number
  detail?: string
  /** Present on a 422, keyed by field. */
  errors?: unknown
  instance?: string
}

const BASE = 'https://open-bugster.dev/problems'

/** The stable identifiers. Adding one is fine; changing one breaks somebody's client. */
const typeByStatus: Record<number, string> = {
  400: `${BASE}/bad-request`,
  401: `${BASE}/unauthorized`,
  403: `${BASE}/forbidden`,
  404: `${BASE}/not-found`,
  405: `${BASE}/method-not-allowed`,
  409: `${BASE}/conflict`,
  413: `${BASE}/payload-too-large`,
  422: `${BASE}/validation-failed`,
  429: `${BASE}/rate-limited`,
  500: `${BASE}/internal-error`
}

const titleByStatus: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  409: 'Conflict',
  413: 'Payload too large',
  422: 'Validation failed',
  429: 'Too many requests',
  500: 'Internal error'
}

/**
 * Turns whatever an operation threw into a problem document.
 *
 * A 5xx deliberately loses its message. An internal failure's text is written for whoever
 * reads the logs, not for whoever is holding a token, and it is exactly the kind of string
 * that leaks a path or a query.
 */
export function toProblem(error: unknown, instance?: string): Problem {
  const candidate = error as { statusCode?: number; statusMessage?: string; message?: string; data?: { issues?: unknown } } | null
  const status = normalizeStatus(candidate?.statusCode)
  const problem: Problem = {
    type: typeByStatus[status] ?? `${BASE}/error`,
    title: titleByStatus[status] ?? 'Error',
    status
  }
  if (status < 500) {
    const detail = candidate?.statusMessage || candidate?.message
    if (detail) problem.detail = detail
    if (candidate?.data?.issues) problem.errors = candidate.data.issues
  }
  if (instance) problem.instance = instance
  return problem
}

function normalizeStatus(value: unknown): number {
  const status = Number(value)
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
}

export function sendProblem(event: H3Event, problem: Problem) {
  setResponseStatus(event, problem.status)
  setHeader(event, 'Content-Type', 'application/problem+json')
  return problem
}
