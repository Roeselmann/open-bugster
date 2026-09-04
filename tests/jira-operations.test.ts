import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The Jira operations: who may touch the connection, and what the log keeps of it. */
describe('the Jira operations', () => {
  let db: typeof import('../server/utils/db')
  let audit: typeof import('../server/utils/audit')
  let actorModule: typeof import('../server/utils/actor')
  let ops: typeof import('../server/operations')

  let boardId = ''
  const people: Record<string, string> = {}
  const actorOf = (who: string) => actorModule.actorFor(db.findUser(people[who]!)!)

  const statusOf = async (promise: Promise<unknown>) => {
    try {
      await promise
      return 200
    } catch (error) {
      return (error as { statusCode?: number }).statusCode ?? 500
    }
  }

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-jira-ops-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.ATTACHMENTS_PATH = join(directory, 'attachments')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    process.env.APP_PASSWORD_HASH = 'scrypt$abc$def'
    process.env.APP_ADMIN_EMAIL = 'owner@example.com'
    process.env.APP_ADMIN_FIRST_NAME = 'Grace'
    process.env.APP_ADMIN_LAST_NAME = 'Hopper'

    db = await import('../server/utils/db')
    audit = await import('../server/utils/audit')
    actorModule = await import('../server/utils/actor')
    ops = await import('../server/operations')

    people.owner = db.listUsers()[0]!.id
    people.editor = db.createUser({ email: 'editor@example.com', firstName: 'Ed', lastName: 'T', role: 'member' }).id
    boardId = db.listBoards()[0]!.id
    db.setBoardMember(boardId, people.editor!, 'editor', true)
  })

  it('keeps the connection with the board’s administrators', async () => {
    expect(await statusOf(ops.run(ops.jiraTokenSet, actorOf('editor'), { boardId, token: 'ATATT-editor' }))).toBe(403)
    expect(await statusOf(ops.run(ops.boardUpdate, actorOf('editor'), { boardId, jira: { siteUrl: 'https://team.atlassian.net' } }))).toBe(403)
    expect(await statusOf(ops.run(ops.jiraTestConnection, actorOf('editor'), { boardId }))).toBe(403)
    expect(await statusOf(ops.run(ops.importRun, actorOf('editor'), { boardId, provider: 'jira' }))).toBe(403)
  })

  it('stores the token sealed, shows only its tail, and keeps it out of the log', async () => {
    const { board } = await ops.run(ops.jiraTokenSet, actorOf('owner'), { boardId, token: 'ATATT3xFfGF0-very-secret-1234' }) as { board: { jira: { tokenLabel: string | null; complete: boolean } } }
    expect(board.jira.tokenLabel).toBe('Token · …1234')
    expect(board.jira.complete).toBe(false)
    expect(JSON.stringify(board)).not.toContain('very-secret')

    const stored = db.getDb().prepare("SELECT secret FROM board_integrations WHERE board_id = ? AND provider = 'jira'").get(boardId) as { secret: string }
    expect(stored.secret).not.toContain('very-secret')
    expect(db.boardJiraCredentials(boardId)?.token).toBe('ATATT3xFfGF0-very-secret-1234')

    const entry = audit.listAudit({ operation: 'jira.setToken' })[0]!
    expect(entry).toMatchObject({ targetId: boardId })
    expect(JSON.stringify(entry)).not.toContain('very-secret')
  })

  it('completes the connection through board.update and reports it on the board', async () => {
    const { board } = await ops.run(ops.boardUpdate, actorOf('owner'), {
      boardId,
      jira: { siteUrl: 'https://team.atlassian.net/browse/APP-1', email: 'grace@example.com', jql: 'project = APP' }
    }) as { board: { jira: Record<string, unknown> } }
    expect(board.jira).toMatchObject({ siteUrl: 'https://team.atlassian.net', email: 'grace@example.com', jql: 'project = APP', complete: true })

    // The TestFlight side is untouched by it.
    expect(db.findBoardSummary(boardId)?.credentials.complete).toBe(false)
    // And a bad site address is refused before anything is stored.
    expect(await statusOf(ops.run(ops.boardUpdate, actorOf('owner'), { boardId, jira: { siteUrl: 'ftp://team.atlassian.net' } }))).toBe(422)
  })

  it('reads and clears the token, and an incomplete connection says so instead of syncing', async () => {
    expect(await statusOf(ops.run(ops.importStatus, actorOf('editor'), { boardId, provider: 'jira' }))).toBe(200)
    expect((await ops.run(ops.importStatus, actorOf('editor'), { boardId }) as { run: unknown }).run).toBeNull()

    const { board } = await ops.run(ops.jiraTokenClear, actorOf('owner'), { boardId }) as { board: { jira: { tokenLabel: string | null; complete: boolean } } }
    expect(board.jira).toMatchObject({ tokenLabel: null, complete: false })
    expect(await statusOf(ops.run(ops.importRun, actorOf('owner'), { boardId, provider: 'jira' }))).toBe(503)
    expect(await statusOf(ops.run(ops.jiraTestConnection, actorOf('owner'), { boardId }))).toBe(503)
  })
})
