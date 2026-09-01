import { beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The level above boards. These cover the three things workspaces add: the migration that
 * introduces them invisibly, the derived visibility rule, and the `workspace` scope's guard.
 */
describe('workspaces', () => {
  let db: typeof import('../server/utils/db')
  let access: typeof import('../server/utils/access')
  let actorModule: typeof import('../server/utils/actor')
  let ops: typeof import('../server/operations')

  let defaultWorkspaceId = ''
  let boardId = ''
  const people: Record<string, string> = {}

  const actorOf = (who: string) => actorModule.actorFor(db.findUser(people[who]!)!)
  const status = (run: () => unknown) => {
    try {
      run()
      return 200
    } catch (error) {
      return (error as { statusCode?: number }).statusCode ?? 500
    }
  }
  const statusOf = async (promise: Promise<unknown>) => {
    try {
      await promise
      return 200
    } catch (error) {
      return (error as { statusCode?: number }).statusCode ?? 500
    }
  }

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-workspaces-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.ATTACHMENTS_PATH = join(directory, 'attachments')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    process.env.APP_PASSWORD_HASH = 'scrypt$abc$def'
    process.env.APP_ADMIN_EMAIL = 'owner@example.com'
    process.env.APP_ADMIN_FIRST_NAME = 'Grace'
    process.env.APP_ADMIN_LAST_NAME = 'Hopper'

    db = await import('../server/utils/db')
    access = await import('../server/utils/access')
    actorModule = await import('../server/utils/actor')
    ops = await import('../server/operations')

    people.owner = db.listUsers()[0]!.id
    for (const [who, role] of [['wsAdmin', 'member'], ['boardEditor', 'member'], ['stranger', 'member']] as const) {
      people[who] = db.createUser({ email: `${who}@example.com`, firstName: who, lastName: 'Test', role }).id
    }

    defaultWorkspaceId = db.defaultWorkspaceId()
    boardId = db.listBoards()[0]!.id
    db.setWorkspaceMember(defaultWorkspaceId, people.wsAdmin!, 'admin')
    db.setBoardMember(boardId, people.boardEditor!, 'editor')
    // `stranger` is a member of nothing, board or workspace.
  })

  describe('the migration', () => {
    it('gives a fresh instance exactly one workspace, named Workspace', () => {
      const workspaces = db.listWorkspaces()
      expect(workspaces).toHaveLength(1)
      expect(workspaces[0]!.name).toBe('Workspace')
      expect(workspaces[0]!.position).toBe(0)
    })

    it('has adopted every board into it', () => {
      for (const board of db.listBoards()) expect(board.workspaceId).toBe(defaultWorkspaceId)
    })

    it('adopts a board that somehow has no workspace, and never doubles up on a rerun', () => {
      const raw = db.getDb()
      raw.prepare("INSERT INTO boards (id, name, position, created_at) VALUES ('orphan', 'Orphan', 99, '2026-01-01T00:00:00.000Z')").run()
      expect(db.ensureWorkspaces(raw)).toBe(false)
      expect(db.findBoard('orphan')!.workspaceId).toBe(defaultWorkspaceId)
      expect(db.countWorkspaces()).toBe(1)
      raw.prepare("DELETE FROM boards WHERE id = 'orphan'").run()
    })
  })

  describe('visibility is derived', () => {
    let secondId = ''

    beforeAll(() => {
      secondId = db.createWorkspace('Second', people.owner!).id
    })

    it('shows an instance admin every workspace, as its admin', () => {
      const workspaces = db.listWorkspaces({ userId: people.owner!, instanceAdmin: true })
      expect(workspaces.map(workspace => workspace.id)).toEqual([defaultWorkspaceId, secondId])
      expect(workspaces.every(workspace => workspace.role === 'admin')).toBe(true)
    })

    it('shows an explicit member their workspace with their role', () => {
      const workspaces = db.listWorkspaces({ userId: people.wsAdmin!, instanceAdmin: false })
      expect(workspaces.map(workspace => workspace.id)).toEqual([defaultWorkspaceId])
      expect(workspaces[0]!.role).toBe('admin')
    })

    it('shows a board member the workspace around their board, with no role of their own', () => {
      const workspaces = db.listWorkspaces({ userId: people.boardEditor!, instanceAdmin: false })
      expect(workspaces.map(workspace => workspace.id)).toEqual([defaultWorkspaceId])
      expect(workspaces[0]!.role).toBeNull()
    })

    it('shows a member of nothing nothing', () => {
      expect(db.listWorkspaces({ userId: people.stranger!, instanceAdmin: false })).toEqual([])
    })
  })

  describe('requireWorkspaceAccess', () => {
    it('hides a workspace from somebody who cannot see it as 404, never 403', () => {
      expect(status(() => access.requireWorkspaceAccess(actorOf('stranger'), defaultWorkspaceId))).toBe(404)
      expect(status(() => access.requireWorkspaceAccess(actorOf('owner'), 'no-such-workspace'))).toBe(404)
    })

    it('lets a board member in as a plain member, and no further', () => {
      expect(access.requireWorkspaceAccess(actorOf('boardEditor'), defaultWorkspaceId).role).toBe('member')
      expect(status(() => access.requireWorkspaceAccess(actorOf('boardEditor'), defaultWorkspaceId, 'admin'))).toBe(403)
    })

    it('resolves an explicit admin, and an instance admin without any row', () => {
      expect(access.requireWorkspaceAccess(actorOf('wsAdmin'), defaultWorkspaceId, 'admin').role).toBe('admin')
      expect(access.requireWorkspaceAccess(actorOf('owner'), defaultWorkspaceId, 'admin').role).toBe('admin')
    })

    it('refuses a board-pinned token outright, with the stranger’s 404', () => {
      const pinned = actorModule.actorFor(db.findUser(people.owner!)!, { channel: 'api', tokenId: 'tok_1', scopes: ['admin'], boardScope: boardId })
      expect(status(() => access.requireWorkspaceAccess(pinned, defaultWorkspaceId))).toBe(404)
    })

    it('caps a token below the admin scope at viewing', () => {
      const writeToken = actorModule.actorFor(db.findUser(people.owner!)!, { channel: 'api', tokenId: 'tok_2', scopes: ['read', 'write'] })
      expect(status(() => access.requireWorkspaceAccess(writeToken, defaultWorkspaceId))).toBe(200)
      expect(status(() => access.requireWorkspaceAccess(writeToken, defaultWorkspaceId, 'admin'))).toBe(403)
    })
  })

  describe('the operations', () => {
    it('reserves creating and deleting workspaces for instance admins', async () => {
      expect(await statusOf(ops.run(ops.workspaceCreate, actorOf('wsAdmin'), { name: 'Skunkworks' }))).toBe(403)
      expect(await statusOf(ops.run(ops.workspaceDelete, actorOf('wsAdmin'), { workspaceId: defaultWorkspaceId }))).toBe(403)
    })

    it('lets a workspace admin rename, and a board-derived member not', async () => {
      const renamed = await ops.run(ops.workspaceUpdate, actorOf('wsAdmin'), { workspaceId: defaultWorkspaceId, name: 'Renamed' }) as { workspace: { name: string } }
      expect(renamed.workspace.name).toBe('Renamed')
      expect(await statusOf(ops.run(ops.workspaceUpdate, actorOf('boardEditor'), { workspaceId: defaultWorkspaceId, name: 'Nope' }))).toBe(403)
      await ops.run(ops.workspaceUpdate, actorOf('wsAdmin'), { workspaceId: defaultWorkspaceId, name: 'Workspace' })
    })

    it('carries a workspace description that survives unrelated updates', async () => {
      expect(db.findWorkspace(defaultWorkspaceId)!.description).toBe('')
      const described = await ops.run(ops.workspaceUpdate, actorOf('wsAdmin'), { workspaceId: defaultWorkspaceId, description: 'Everything the studio ships' }) as { workspace: { description: string } }
      expect(described.workspace.description).toBe('Everything the studio ships')
      // A name-only update must not touch it — omitted means "keep", empty means "clear".
      await ops.run(ops.workspaceUpdate, actorOf('wsAdmin'), { workspaceId: defaultWorkspaceId, name: 'Still described' })
      expect(db.findWorkspace(defaultWorkspaceId)!.description).toBe('Everything the studio ships')
      await ops.run(ops.workspaceUpdate, actorOf('wsAdmin'), { workspaceId: defaultWorkspaceId, name: 'Workspace', description: '' })
      expect(db.findWorkspace(defaultWorkspaceId)!.description).toBe('')
    })

    it('refuses to delete a workspace that still holds boards, and the last one', async () => {
      expect(await statusOf(ops.run(ops.workspaceDelete, actorOf('owner'), { workspaceId: defaultWorkspaceId }))).toBe(409)
      const doomed = db.createWorkspace('Doomed')
      await ops.run(ops.workspaceDelete, actorOf('owner'), { workspaceId: doomed.id })
      expect(db.findWorkspace(doomed.id)).toBeNull()
    })

    it('manages members through the workspace admin', async () => {
      const set = await ops.run(ops.workspaceMemberSet, actorOf('wsAdmin'), { workspaceId: defaultWorkspaceId, userId: people.boardEditor!, role: 'member' }) as { member: { role: string } }
      expect(set.member.role).toBe('member')
      expect(await statusOf(ops.run(ops.workspaceMemberRemove, actorOf('wsAdmin'), { workspaceId: defaultWorkspaceId, userId: people.boardEditor! }))).toBe(200)
      expect(await statusOf(ops.run(ops.workspaceMemberSet, actorOf('boardEditor'), { workspaceId: defaultWorkspaceId, userId: people.stranger!, role: 'member' }))).toBe(403)
    })
  })

  describe('boards inside workspaces', () => {
    it('positions boards per workspace, starting each workspace at zero', () => {
      const second = db.createWorkspace('Positioning')
      const first = db.createBoard('First here', null, second.id)
      const next = db.createBoard('Second here', null, second.id)
      expect(first.workspaceId).toBe(second.id)
      expect(first.position).toBe(0)
      expect(next.position).toBe(1)
    })

    it('lands a board with no workspace named in the default workspace', () => {
      expect(db.createBoard('Homeless').workspaceId).toBe(defaultWorkspaceId)
    })

    it('lets a workspace admin open boards there, and nobody lesser', async () => {
      const created = await ops.run(ops.boardCreate, actorOf('wsAdmin'), { name: 'By ws admin', workspaceId: defaultWorkspaceId }) as { board: { workspaceId: string; role: string } }
      expect(created.board.workspaceId).toBe(defaultWorkspaceId)
      expect(created.board.role).toBe('admin')
      expect(await statusOf(ops.run(ops.boardCreate, actorOf('boardEditor'), { name: 'Denied', workspaceId: defaultWorkspaceId }))).toBe(403)
      // A stranger asking without naming a workspace resolves to the default one — and 404s.
      expect(await statusOf(ops.run(ops.boardCreate, actorOf('stranger'), { name: 'Denied' }))).toBe(404)
    })

    it('reorders a workspace’s boards only as a complete permutation', async () => {
      const workspace = db.createWorkspace('Ordered')
      const a = db.createBoard('A', null, workspace.id)
      const b = db.createBoard('B', null, workspace.id)
      expect(await statusOf(ops.run(ops.workspaceBoardOrder, actorOf('owner'), { workspaceId: workspace.id, boardIds: [b.id] }))).toBe(422)
      await ops.run(ops.workspaceBoardOrder, actorOf('owner'), { workspaceId: workspace.id, boardIds: [b.id, a.id] })
      expect(db.findBoard(b.id)!.position).toBe(0)
      expect(db.findBoard(a.id)!.position).toBe(1)
    })
  })

  describe('moving and duplicating boards', () => {
    let targetWsId = ''
    let sourceBoardId = ''
    let sourceTicketId = ''
    const attachmentBytes = 'not really a png'

    beforeAll(async () => {
      targetWsId = db.createWorkspace('Move target').id
      const sourceBoard = db.createBoard('Original', people.owner!, defaultWorkspaceId)
      sourceBoardId = sourceBoard.id
      db.setBoardMember(sourceBoardId, people.boardEditor!, 'editor')
      const lane = sourceBoard.lanes.find(item => !item.isImport)!
      const author = db.personById(people.owner!)
      const ticket = db.createTicket(sourceBoardId, {
        title: 'Crash on export', laneId: lane.id, labels: ['crash'], categoryName: 'Bug',
        todos: [{ text: 'Reproduce', completed: false }]
      }, author)!
      sourceTicketId = ticket.id
      const archived = db.createTicket(sourceBoardId, { title: 'Old one', laneId: lane.id }, author)!
      db.archiveTicket(archived.id, actorOf('owner'))
      const relativePath = join(ticket.id, 'shot.png')
      await mkdir(join(process.env.ATTACHMENTS_PATH!, ticket.id), { recursive: true })
      await writeFile(join(process.env.ATTACHMENTS_PATH!, relativePath), attachmentBytes)
      db.addAttachment(ticket.id, 'screenshot', 'shot.png', 'image/png', attachmentBytes.length, relativePath)
    })

    it('answers a board admin who cannot see the destination with the stranger’s 404', async () => {
      db.setBoardMember(sourceBoardId, people.wsAdmin!, 'admin')
      expect(await statusOf(ops.run(ops.boardMove, actorOf('wsAdmin'), { boardId: sourceBoardId, workspaceId: targetWsId }))).toBe(404)
    })

    it('refuses moving a board to where it already is', async () => {
      expect(await statusOf(ops.run(ops.boardMove, actorOf('owner'), { boardId: sourceBoardId, workspaceId: defaultWorkspaceId }))).toBe(409)
    })

    it('moves a board with its members, slotting in at the end of the target', async () => {
      const { board } = await ops.run(ops.boardMove, actorOf('owner'), { boardId: sourceBoardId, workspaceId: targetWsId }) as
        { board: { workspaceId: string; position: number; members: Array<{ userId: string }> } }
      expect(board.workspaceId).toBe(targetWsId)
      expect(board.position).toBe(0)
      expect(board.members.some(member => member.userId === people.boardEditor)).toBe(true)
    })

    it('duplicates the structure without tickets or credentials', async () => {
      const { board } = await ops.run(ops.boardDuplicate, actorOf('owner'), { boardId: sourceBoardId, name: 'Original (copy)' }) as
        { board: { id: string; workspaceId: string; ticketCount: number; lanes: Array<{ name: string; isImport: boolean }>; members: Array<{ userId: string; role: string }>; credentials: { complete: boolean } } }
      // An omitted target duplicates in place — which is the target workspace after the move.
      expect(board.workspaceId).toBe(targetWsId)
      expect(board.lanes.map(lane => lane.name)).toEqual(db.findBoardSummary(sourceBoardId)!.lanes.map(lane => lane.name))
      expect(board.lanes.filter(lane => lane.isImport)).toHaveLength(1)
      expect(board.ticketCount).toBe(0)
      expect(board.credentials.complete).toBe(false)
      expect(board.members.some(member => member.userId === people.boardEditor && member.role === 'editor')).toBe(true)
      expect(board.members.some(member => member.userId === people.owner && member.role === 'admin')).toBe(true)
      expect(db.listLabels(board.id).map(label => label.name)).toEqual(['crash'])
      expect(db.listCategories(board.id).map(category => category.name)).toEqual(['Bug'])
    })

    it('duplicates tickets with fresh numbers, remapped relations, and copied files', async () => {
      const before = (db.getDb().prepare('SELECT MAX(ticket_number) AS value FROM tickets').get() as { value: number }).value
      const { board } = await ops.run(ops.boardDuplicate, actorOf('owner'), { boardId: sourceBoardId, name: 'Full copy', includeTickets: true }) as { board: { id: string } }
      const rows = db.getDb().prepare('SELECT id, ticket_number, archived_at FROM tickets WHERE board_id = ? ORDER BY ticket_number')
        .all(board.id) as Array<{ id: string; ticket_number: number; archived_at: string | null }>
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map(row => row.ticket_number)).size).toBe(2)
      expect(rows.every(row => row.ticket_number > before)).toBe(true)
      expect(rows.some(row => row.archived_at)).toBe(true)

      const copy = db.findTicket(rows.find(row => !row.archived_at)!.id)!
      expect(copy.labels.map(label => label.name)).toEqual(['crash'])
      expect(copy.category?.name).toBe('Bug')
      expect(copy.todos.map(todo => todo.text)).toEqual(['Reproduce'])
      // The copy's label row belongs to the copy's board — remapped, never shared.
      expect(db.listLabels(board.id)[0]!.id).not.toBe(db.listLabels(sourceBoardId)[0]!.id)

      const attachment = db.getDb().prepare('SELECT relative_path FROM attachments WHERE ticket_id = ?').get(copy.id) as { relative_path: string }
      expect(attachment.relative_path.startsWith(copy.id)).toBe(true)
      expect(existsSync(join(process.env.ATTACHMENTS_PATH!, attachment.relative_path))).toBe(true)
      // The original file is untouched.
      expect(existsSync(join(process.env.ATTACHMENTS_PATH!, join(sourceTicketId, 'shot.png')))).toBe(true)
    })
  })
})
