import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { JiraConnection, SyncRun } from '../../shared/types/domain'
import { MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_SIZE, extensionForMime, hasAllowedExtension, safeUploadFilename } from './attachment-policy'
import { addAttachment, createSyncRun, finishSyncRun, hasExternalTicket, insertImportedTicket } from './db'
import { describeIssue, issueUrl, jiraPriorityToBugster, normalizeSiteUrl, titleFromIssue, type JiraCommentInput } from './jira-policy'
import { acquireSyncLock } from './sync-lock'

/**
 * Jira Cloud, one way in.
 *
 * A board's JQL picks the issues, a sync copies the ones not on the board yet into the import
 * lane, and from then on the ticket is the board's. Nothing is written back to Jira. The client
 * speaks the v3 REST API with basic auth — an Atlassian account's email and an API token — and
 * pages the enhanced search by `nextPageToken`, the only search Jira Cloud still answers.
 * The verify step also sends the query as it is; only `maxResults` differs.
 */

export class JiraApiError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message)
  }
}

export interface JiraAuth {
  siteUrl: string
  email: string
  token: string
}

type JiraIssueResource = {
  id: string
  key: string
  fields?: Record<string, unknown>
}

type JiraSearchPage = {
  issues?: JiraIssueResource[]
  nextPageToken?: string
  isLast?: boolean
}

type JiraAttachment = {
  id: string
  filename: string
  mimeType: string | null
  size: number
  content: string
}

/** The fields a sync asks for: everything the ticket, its metadata panel and its labels are built from. */
const ISSUE_FIELDS = ['summary', 'description', 'status', 'issuetype', 'priority', 'reporter', 'assignee', 'created', 'updated', 'labels', 'project', 'attachment', 'comment']

export function basicAuthorization(email: string, token: string) {
  return `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`
}

function jiraError(status: number, detail: string | null) {
  if (status === 400) return detail ? `Jira rejected the query: ${detail}` : 'Jira rejected the query.'
  if (status === 401) return 'Jira rejected the credentials. Check the email and the API token — tokens expire after at most a year.'
  if (status === 403) return 'The Jira account does not have permission to read these issues.'
  if (status === 404) return 'The Jira site or resource was not found. Check the site address.'
  if (status === 410) return 'Jira has retired this API endpoint. Update Open-Bugster.'
  if (status === 429) return 'The Jira rate limit has been reached. Try syncing again later.'
  return status >= 500 ? 'Jira is temporarily unavailable.' : 'Jira rejected the request.'
}

/** What Jira puts in an error body, when it puts anything readable there. */
async function errorDetail(response: Response): Promise<string | null> {
  try {
    const body = await response.json() as { errorMessages?: unknown; errors?: Record<string, unknown> }
    const messages = Array.isArray(body.errorMessages) ? body.errorMessages.filter((item): item is string => typeof item === 'string') : []
    const fields = body.errors ? Object.values(body.errors).filter((item): item is string => typeof item === 'string') : []
    const text = [...messages, ...fields].join(' ').trim()
    return text ? text.slice(0, 300) : null
  } catch {
    return null
  }
}

async function jiraFetch<T>(auth: JiraAuth, path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const site = normalizeSiteUrl(auth.siteUrl)
  const url = new URL(path, site)
  // Every request stays on the configured site; a link Jira handed back cannot lead elsewhere.
  if (url.origin !== site) throw new JiraApiError(502, 'Jira returned a link to another site.')
  let response: Response
  try {
    response = await fetch(url, {
      method: init.method || 'GET',
      headers: {
        Authorization: basicAuthorization(auth.email, auth.token),
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined
    })
  } catch {
    throw new JiraApiError(502, 'Jira is currently unreachable.')
  }
  if (!response.ok) throw new JiraApiError(response.status, jiraError(response.status, response.status === 400 ? await errorDetail(response) : null))
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function named(value: unknown): string | null {
  return typeof value === 'object' && value !== null ? text((value as { name?: unknown }).name) : null
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/**
 * Proves the credentials without importing: who the token belongs to, whether the JQL parses,
 * and roughly how many issues it matches today.
 */
export async function verifyJiraAccess(config: { siteUrl: string; email: string; jql: string; token: string | null }): Promise<JiraConnection> {
  if (!config.siteUrl || !config.email || !config.token) {
    throw new JiraApiError(503, 'The Jira configuration of this board is incomplete.')
  }
  const auth: JiraAuth = { siteUrl: config.siteUrl, email: config.email, token: config.token }
  const me = await jiraFetch<{ displayName?: unknown; emailAddress?: unknown }>(auth, '/rest/api/3/myself')
  const jql = config.jql.trim() || 'ORDER BY created DESC'
  await jiraFetch<JiraSearchPage>(auth, '/rest/api/3/search/jql', { method: 'POST', body: { jql, maxResults: 1, fields: ['id'] } })
  let matchingIssues: number | null = null
  try {
    const counted = await jiraFetch<{ count?: unknown }>(auth, '/rest/api/3/search/approximate-count', { method: 'POST', body: { jql } })
    matchingIssues = typeof counted.count === 'number' ? counted.count : null
  } catch {
    // The count is a courtesy; a site that cannot give one still connected.
  }
  return { displayName: text(me.displayName), email: text(me.emailAddress), matchingIssues }
}

function attachmentsOf(fields: Record<string, unknown>): JiraAttachment[] {
  const list = Array.isArray(fields.attachment) ? fields.attachment : []
  return list.map(record).flatMap(item => {
    const id = text(item.id) ?? (typeof item.id === 'number' ? String(item.id) : null)
    const filename = text(item.filename)
    const content = text(item.content)
    if (!id || !filename || !content) return []
    return [{ id, filename, mimeType: text(item.mimeType), size: Number(item.size) || 0, content }]
  })
}

function commentsOf(fields: Record<string, unknown>): JiraCommentInput[] {
  const list = Array.isArray(record(fields.comment).comments) ? record(fields.comment).comments as unknown[] : []
  return list.map(record).map(item => ({
    author: text(record(item.author).displayName),
    created: text(item.created),
    body: item.body
  }))
}

async function saveAttachment(ticketId: string, auth: JiraAuth, attachment: JiraAttachment, attachmentsPath: string) {
  const filename = safeUploadFilename(attachment.filename)
  const extension = hasAllowedExtension(filename) ? '' : extensionForMime(attachment.mimeType || undefined)
  if (extension === null) throw new Error(`The file type of “${filename}” is not supported.`)
  if (attachment.size > MAX_ATTACHMENT_SIZE) throw new Error(`“${filename}” is larger than 25 MB.`)
  const site = normalizeSiteUrl(auth.siteUrl)
  const url = new URL(attachment.content, site)
  if (url.origin !== site) throw new Error('The attachment lives on another site.')
  // Jira answers with a redirect to a signed media URL; fetch follows it and drops the
  // Authorization header on the way, which is exactly what a cross-origin hop should do.
  const response = await fetch(url, { headers: { Authorization: basicAuthorization(auth.email, auth.token) } })
  if (!response.ok) throw new Error(`The attachment could not be downloaded (${response.status}).`)
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > MAX_ATTACHMENT_SIZE) throw new Error(`“${filename}” is larger than 25 MB.`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length) throw new Error(`“${filename}” is empty.`)
  if (bytes.length > MAX_ATTACHMENT_SIZE) throw new Error(`“${filename}” is larger than 25 MB.`)
  const mimeType = attachment.mimeType?.split(';')[0]?.trim().toLowerCase() || response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream'
  const stored = `jira-${attachment.id}-${filename}${extension}`
  const directory = join(attachmentsPath, ticketId)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, stored), bytes, { flag: 'wx' })
  addAttachment(ticketId, mimeType.startsWith('image/') ? 'screenshot' : 'file', stored, mimeType, bytes.length, join(ticketId, stored))
}

export async function syncJira(config: {
  boardId: string
  laneId: string
  siteUrl: string
  email: string
  jql: string
  token: string | null
  syncLimit: number
  autoAuthor: boolean
  importTypeId: string | null
  attachmentsPath: string
}): Promise<SyncRun> {
  const release = acquireSyncLock(config.boardId, 'jira')
  if (!release) throw new JiraApiError(409, 'A Jira sync is already in progress for this board.')
  if (!config.siteUrl || !config.email || !config.jql.trim() || !config.token) {
    release()
    throw new JiraApiError(503, 'The Jira configuration of this board is incomplete.')
  }
  const auth: JiraAuth = { siteUrl: config.siteUrl, email: config.email, token: config.token }
  const run = createSyncRun(config.boardId, 'jira')
  let imported = 0
  let skipped = 0
  let failed = 0
  try {
    // The query goes to Jira exactly as the board has it. Nothing is appended — no time
    // window, no ordering — so what the settings page says is what runs, and the JQL help
    // there shows how to narrow or order it. Deduplication by issue id keeps repeats out.
    const jql = config.jql.trim()
    const pageSize = Math.min(100, Math.max(1, config.syncLimit))
    let examined = 0
    let nextPageToken: string | undefined
    let done = false

    // The scan stops after the configured number of issues, in the order Jira returns them.
    while (!done) {
      const page = await jiraFetch<JiraSearchPage>(auth, '/rest/api/3/search/jql', {
        method: 'POST',
        body: { jql, maxResults: pageSize, fields: ISSUE_FIELDS, ...(nextPageToken ? { nextPageToken } : {}) }
      })
      for (const issue of page.issues || []) {
        if (examined >= config.syncLimit) {
          done = true
          break
        }
        examined++
        const fields = record(issue.fields)
        const created = text(fields.created)
        if (!created) {
          failed++
          continue
        }
        if (hasExternalTicket(config.boardId, issue.id)) {
          skipped++
          continue
        }
        const reporter = record(fields.reporter)
        const status = record(fields.status)
        try {
          const ticket = insertImportedTicket({
            source: 'jira_issue',
            boardId: config.boardId,
            laneId: config.laneId,
            externalId: issue.id,
            title: titleFromIssue(issue.key, text(fields.summary)),
            description: describeIssue(fields.description, commentsOf(fields)),
            priority: jiraPriorityToBugster(named(fields.priority)),
            reporterEmail: text(reporter.emailAddress),
            reporterName: text(reporter.displayName),
            autoAuthor: config.autoAuthor,
            typeId: config.importTypeId,
            issue: {
              issueId: issue.id,
              issueKey: issue.key,
              projectKey: text(record(fields.project).key),
              issueType: named(fields.issuetype),
              status: text(status.name),
              statusCategory: named(status.statusCategory),
              jiraPriority: named(fields.priority),
              assigneeName: text(record(fields.assignee).displayName),
              url: issueUrl(config.siteUrl, issue.key),
              labels: Array.isArray(fields.labels) ? fields.labels.filter((label): label is string => typeof label === 'string') : [],
              sourceCreatedAt: created,
              sourceUpdatedAt: text(fields.updated)
            },
            raw: issue
          })
          imported++
          for (const attachment of attachmentsOf(fields).slice(0, MAX_ATTACHMENT_COUNT)) {
            try {
              await saveAttachment(ticket.id, auth, attachment, config.attachmentsPath)
            } catch {
              failed++
            }
          }
        } catch (error) {
          if (error instanceof Error && /UNIQUE constraint failed: .*tickets\.external_id/.test(error.message)) skipped++
          else failed++
        }
      }
      nextPageToken = page.nextPageToken
      if (!nextPageToken || page.isLast || !(page.issues || []).length) done = true
    }
    return finishSyncRun(config.boardId, run.id, failed ? 'partial' : 'success', imported, skipped, failed, failed ? 'Some attachments or issues could not be imported.' : null)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown import error.'
    finishSyncRun(config.boardId, run.id, 'failed', imported, skipped, failed + 1, message)
    throw error
  } finally {
    release()
  }
}
