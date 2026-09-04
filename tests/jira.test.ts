import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The Jira client against a Jira that is a function: `fetch` is replaced per test, and each
 * request is recorded so the tests can say what was asked as well as what came back.
 */
describe('the Jira import', () => {
  let db: typeof import('../server/utils/db')
  let jira: typeof import('../server/utils/jira')
  let boardId = ''
  let laneId = ''
  let attachmentsPath = ''

  const SITE = 'https://team.atlassian.net'
  const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000).toISOString()
  const paragraph = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

  type Call = { url: string; method: string; body: Record<string, unknown> | null; authorization: string | null }
  const calls: Call[] = []

  function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
  }

  /** Installs a fake Jira; `handler` decides per request, and every request is logged. */
  function mockJira(handler: (call: Call) => Response | Promise<Response>) {
    calls.length = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      const headers = new Headers(init?.headers)
      const call: Call = { url, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, authorization: headers.get('authorization') }
      calls.push(call)
      return handler(call)
    }))
  }

  function issue(id: number, key: string, overrides: Record<string, unknown> = {}) {
    return {
      id: String(id),
      key,
      fields: {
        summary: `Issue ${key}`,
        description: paragraph(`Body of ${key}`),
        status: { name: 'To Do', statusCategory: { name: 'To Do' } },
        issuetype: { name: 'Bug' },
        priority: { name: 'High' },
        reporter: { displayName: 'Grace Hopper' },
        assignee: null,
        created: iso(id),
        updated: iso(0),
        labels: ['ios'],
        project: { key: 'APP' },
        attachment: [],
        comment: { comments: [] },
        ...overrides
      }
    }
  }

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-jira-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    attachmentsPath = join(directory, 'attachments')
    db = await import('../server/utils/db')
    jira = await import('../server/utils/jira')
    const board = db.listBoards()[0]!
    boardId = board.id
    laneId = board.lanes.find(lane => lane.isImport)!.id
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('signs requests with basic auth and keeps them on the configured site', async () => {
    expect(jira.basicAuthorization('me@example.com', 'tok')).toBe(`Basic ${Buffer.from('me@example.com:tok').toString('base64')}`)
    mockJira(call => {
      if (call.url.endsWith('/rest/api/3/myself')) return jsonResponse(200, { displayName: 'Grace Hopper', emailAddress: 'me@example.com' })
      if (call.url.endsWith('/rest/api/3/search/jql')) return jsonResponse(200, { issues: [], isLast: true })
      if (call.url.endsWith('/rest/api/3/search/approximate-count')) return jsonResponse(200, { count: 7 })
      return jsonResponse(404, {})
    })
    const connection = await jira.verifyJiraAccess({ siteUrl: `${SITE}/browse/APP-1`, email: 'me@example.com', jql: 'project = APP', token: 'tok' })
    expect(connection).toEqual({ displayName: 'Grace Hopper', email: 'me@example.com', matchingIssues: 7 })
    expect(calls.map(call => call.url)).toEqual([
      `${SITE}/rest/api/3/myself`,
      `${SITE}/rest/api/3/search/jql`,
      `${SITE}/rest/api/3/search/approximate-count`
    ])
    expect(calls[0]!.authorization).toBe(jira.basicAuthorization('me@example.com', 'tok'))
    expect(calls[1]!.body).toMatchObject({ jql: 'project = APP', maxResults: 1 })
  })

  it('turns Jira’s answers into messages a person can act on', async () => {
    const attempt = (status: number, body: unknown = {}) => {
      mockJira(() => jsonResponse(status, body))
      return jira.verifyJiraAccess({ siteUrl: SITE, email: 'me@example.com', jql: '', token: 'tok' })
    }
    await expect(attempt(401)).rejects.toMatchObject({ statusCode: 401, message: expect.stringMatching(/tokens expire/) })
    await expect(attempt(403)).rejects.toMatchObject({ statusCode: 403 })
    await expect(attempt(410)).rejects.toMatchObject({ statusCode: 410, message: expect.stringMatching(/retired/) })
    await expect(attempt(429)).rejects.toMatchObject({ statusCode: 429 })
    await expect(attempt(503)).rejects.toMatchObject({ statusCode: 503, message: expect.stringMatching(/temporarily unavailable/) })

    // A bad JQL comes back as 400 with Jira's own explanation, which is the useful part.
    mockJira(call => call.url.endsWith('/myself')
      ? jsonResponse(200, { displayName: 'Grace' })
      : jsonResponse(400, { errorMessages: ["Field 'bogus' does not exist."] }))
    await expect(jira.verifyJiraAccess({ siteUrl: SITE, email: 'me@example.com', jql: 'bogus = 1', token: 'tok' }))
      .rejects.toMatchObject({ statusCode: 400, message: "Jira rejected the query: Field 'bogus' does not exist." })

    await expect(jira.verifyJiraAccess({ siteUrl: SITE, email: '', jql: '', token: 'tok' })).rejects.toMatchObject({ statusCode: 503 })
    mockJira(() => { throw new TypeError('fetch failed') })
    await expect(jira.verifyJiraAccess({ siteUrl: SITE, email: 'me@example.com', jql: '', token: 'tok' })).rejects.toMatchObject({ statusCode: 502 })
  })

  it('imports the issues page by page, skips what is on the board, and stops at the limit', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    const first = issue(1, 'APP-1', {
      summary: '  Crash   on launch ',
      description: paragraph('Steps to reproduce'),
      priority: { name: 'Highest' },
      reporter: { displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' },
      assignee: { displayName: 'Grace Hopper' },
      comment: { comments: [{ author: { displayName: 'Grace Hopper' }, created: '2026-08-20T09:30:00.000Z', body: paragraph('Reproduced.') }] },
      attachment: [
        { id: '5001', filename: 'screen.png', mimeType: 'image/png', size: png.length, content: `${SITE}/rest/api/3/attachment/content/5001` },
        { id: '5002', filename: 'dump.bin', mimeType: 'application/octet-stream', size: 10, content: `${SITE}/rest/api/3/attachment/content/5002` }
      ]
    })
    const pages = [
      { issues: [first, issue(2, 'APP-2', { issuetype: { name: 'Story' }, priority: { name: 'Low' } })], nextPageToken: 'page-2', isLast: false },
      { issues: [issue(3, 'APP-3'), issue(4, 'APP-4')], isLast: true }
    ]
    mockJira(call => {
      if (call.url.endsWith('/rest/api/3/search/jql')) return jsonResponse(200, call.body?.nextPageToken === 'page-2' ? pages[1] : pages[0])
      if (call.url.endsWith('/attachment/content/5001')) return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } })
      return jsonResponse(404, {})
    })

    // APP-3 is already on the board, from an earlier sync.
    db.insertImportedTicket({
      source: 'jira_issue', boardId, laneId, externalId: '3', title: 'Already here', description: '', priority: 'medium',
      reporterEmail: null, reporterName: null,
      issue: { issueId: '3', issueKey: 'APP-3', projectKey: 'APP', issueType: 'Bug', status: null, statusCategory: null, jiraPriority: null, assigneeName: null, url: `${SITE}/browse/APP-3`, labels: [], sourceCreatedAt: iso(3), sourceUpdatedAt: null },
      raw: {}
    })

    const run = await jira.syncJira({
      boardId, laneId, siteUrl: SITE, email: 'me@example.com', jql: 'project = APP ORDER BY created DESC', token: 'tok',
      syncLimit: 3, autoAuthor: true, importTypeId: null, attachmentsPath
    })

    // Three examined: APP-1 and APP-2 imported, APP-3 skipped, APP-4 never looked at. The
    // unsupported attachment counts as a failure and makes the run partial.
    expect(run).toMatchObject({ provider: 'jira', status: 'partial', importedCount: 2, skippedCount: 1, failedCount: 1 })
    const searches = calls.filter(call => call.url.endsWith('/search/jql'))
    expect(searches).toHaveLength(2)
    expect(searches[0]!.body).toMatchObject({ maxResults: 3, fields: expect.arrayContaining(['summary', 'description', 'attachment', 'comment']) })
    // The JQL goes to Jira exactly as the board has it: nothing appended, nothing reordered.
    expect(searches[0]!.body!.jql).toBe('project = APP ORDER BY created DESC')
    expect(searches[1]!.body).toMatchObject({ nextPageToken: 'page-2' })

    const tickets = db.listTickets(boardId).filter(ticket => ticket.source === 'jira_issue')
    const crash = tickets.find(ticket => ticket.externalId === '1')!
    expect(crash).toMatchObject({ title: 'Crash on launch', priority: 'urgent', laneId, link: `${SITE}/browse/APP-1` })
    expect(crash.description).toBe('Steps to reproduce\n\n## Comments from Jira\n\n**Grace Hopper** · 2026-08-20 09:30 UTC\n\nReproduced.')
    expect(crash.labels.map(label => label.name).sort()).toEqual(['Bug', 'Jira'])
    expect(crash.jira).toMatchObject({
      issueId: '1', issueKey: 'APP-1', projectKey: 'APP', issueType: 'Bug', status: 'To Do', statusCategory: 'To Do', jiraPriority: 'Highest',
      reporterName: 'Ada Lovelace', assigneeName: 'Grace Hopper', url: `${SITE}/browse/APP-1`, labels: ['ios']
    })
    expect(crash.jira?.reporter).toMatchObject({ email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' })
    expect(crash.author).toBeNull()
    expect(crash.attachments).toHaveLength(1)
    expect(crash.attachments[0]).toMatchObject({ kind: 'screenshot', filename: 'jira-5001-screen.png', mimeType: 'image/png', size: png.length })
    expect(await readdir(join(attachmentsPath, crash.id))).toEqual(['jira-5001-screen.png'])
    // The download carried the credentials Jira needs before it redirects to its media host.
    expect(calls.find(call => call.url.endsWith('/attachment/content/5001'))?.authorization).toBe(jira.basicAuthorization('me@example.com', 'tok'))

    const story = tickets.find(ticket => ticket.externalId === '2')!
    expect(story).toMatchObject({ priority: 'low' })
    expect(story.labels.map(label => label.name).sort()).toEqual(['Jira', 'Story'])
    expect(story.jira?.reporter).toBeNull()
    expect(story.jira?.reporterName).toBe('Grace Hopper')
    expect(tickets.some(ticket => ticket.externalId === '4')).toBe(false)

    // A wider next sync skips the three it knows and reaches APP-4; the attachment that failed
    // is not retried, because its ticket is already on the board.
    const again = await jira.syncJira({
      boardId, laneId, siteUrl: SITE, email: 'me@example.com', jql: 'project = APP ORDER BY created DESC', token: 'tok',
      syncLimit: 10, autoAuthor: true, importTypeId: null, attachmentsPath
    })
    expect(again).toMatchObject({ status: 'success', importedCount: 1, skippedCount: 3, failedCount: 0 })
    expect(calls.filter(call => call.url.endsWith('/search/jql')).at(-1)!.body!.jql).toBe('project = APP ORDER BY created DESC')
    expect(db.latestSyncRun(boardId, 'jira')?.id).toBe(again.id)
    expect(db.latestSyncRun(boardId, 'testflight')).toBeNull()
  })

  it('refuses an incomplete connection and records a failed run when Jira does', async () => {
    await expect(jira.syncJira({ boardId, laneId, siteUrl: SITE, email: 'me@example.com', jql: 'project = APP', token: null, syncLimit: 10, autoAuthor: true, importTypeId: null, attachmentsPath }))
      .rejects.toMatchObject({ statusCode: 503 })

    mockJira(() => jsonResponse(401, {}))
    await expect(jira.syncJira({ boardId, laneId, siteUrl: SITE, email: 'me@example.com', jql: 'project = APP', token: 'expired', syncLimit: 10, autoAuthor: true, importTypeId: null, attachmentsPath }))
      .rejects.toMatchObject({ statusCode: 401 })
    expect(db.latestSyncRun(boardId, 'jira')).toMatchObject({ status: 'failed', errorMessage: expect.stringMatching(/rejected the credentials/) })
  })
})
