import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { satisfiesRole } from '../server/utils/access'
import { boardRoles } from '../shared/types/domain'

describe('board role ranking', () => {
  it('lets every role cover itself', () => {
    for (const role of boardRoles) expect(satisfiesRole(role, role)).toBe(true)
  })

  it('ranks admin above editor above viewer', () => {
    expect(satisfiesRole('admin', 'editor')).toBe(true)
    expect(satisfiesRole('admin', 'viewer')).toBe(true)
    expect(satisfiesRole('editor', 'viewer')).toBe(true)
  })

  it('refuses to promote a lower role', () => {
    expect(satisfiesRole('viewer', 'editor')).toBe(false)
    expect(satisfiesRole('viewer', 'admin')).toBe(false)
    expect(satisfiesRole('editor', 'admin')).toBe(false)
  })
})

/**
 * The guards themselves, which went untested for as long as they took an H3Event and could
 * not be called without one. Taking an `Actor` is what makes them reachable from here.
 */
describe('access guards', () => {
  let db: typeof import('../server/utils/db')
  let access: typeof import('../server/utils/access')
  let actorModule: typeof import('../server/utils/actor')

  let boardId = ''
  let otherBoardId = ''
  let laneId = ''
  let ticketId = ''
  let archivedTicketId = ''

  /** One account per role, so every branch below has somebody who really holds it. */
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

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-access-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    process.env.APP_PASSWORD_HASH = 'scrypt$abc$def'
    process.env.APP_ADMIN_EMAIL = 'owner@example.com'
    process.env.APP_ADMIN_FIRST_NAME = 'Grace'
    process.env.APP_ADMIN_LAST_NAME = 'Hopper'

    db = await import('../server/utils/db')
    access = await import('../server/utils/access')
    actorModule = await import('../server/utils/actor')

    people.owner = db.listUsers()[0]!.id
    for (const [who, role] of [['admin', 'admin'], ['boardAdmin', 'member'], ['editor', 'member'], ['viewer', 'member'], ['stranger', 'member']] as const) {
      people[who] = db.createUser({ email: `${who}@example.com`, firstName: who, lastName: 'Test', role }).id
    }

    const board = db.listBoards()[0]!
    boardId = board.id
    laneId = board.lanes.find(lane => !lane.isImport)!.id
    otherBoardId = db.createBoard('Second board').id

    db.setBoardMember(boardId, people.boardAdmin!, 'admin')
    db.setBoardMember(boardId, people.editor!, 'editor')
    db.setBoardMember(boardId, people.viewer!, 'viewer')
    // `stranger` is deliberately a member of nothing.

    const author = db.personById(people.editor!)
    ticketId = db.createTicket(boardId, { title: 'Live ticket', laneId } as never, author)!.id
    archivedTicketId = db.createTicket(boardId, { title: 'Archived ticket', laneId } as never, author)!.id
    db.archiveTicket(archivedTicketId, actorModule.actorFor(db.findUser(people.boardAdmin!)!))
  })

  describe('requireBoardAccess', () => {
    it('gives an instance admin admin rights on every board, member or not', () => {
      for (const who of ['owner', 'admin']) {
        expect(access.requireBoardAccess(actorOf(who), boardId).role).toBe('admin')
        expect(access.requireBoardAccess(actorOf(who), otherBoardId).role).toBe('admin')
      }
    })

    it('reports the role a member actually holds', () => {
      expect(access.requireBoardAccess(actorOf('boardAdmin'), boardId).role).toBe('admin')
      expect(access.requireBoardAccess(actorOf('editor'), boardId).role).toBe('editor')
      expect(access.requireBoardAccess(actorOf('viewer'), boardId).role).toBe('viewer')
    })

    it('hides a board from a non-member as 404, never 403', () => {
      // The distinction is the point: a 403 would confirm the id names a real board.
      expect(status(() => access.requireBoardAccess(actorOf('stranger'), boardId))).toBe(404)
      expect(status(() => access.requireBoardAccess(actorOf('editor'), otherBoardId))).toBe(404)
    })

    it('answers an unknown board id the same way as one the caller cannot see', () => {
      expect(status(() => access.requireBoardAccess(actorOf('owner'), 'no-such-board'))).toBe(404)
    })

    it('refuses an under-ranked member with 403, because the board is no secret to them', () => {
      expect(status(() => access.requireBoardAccess(actorOf('viewer'), boardId, 'editor'))).toBe(403)
      expect(status(() => access.requireBoardAccess(actorOf('viewer'), boardId, 'admin'))).toBe(403)
      expect(status(() => access.requireBoardAccess(actorOf('editor'), boardId, 'admin'))).toBe(403)
    })

    it('lets a sufficient role through', () => {
      expect(status(() => access.requireBoardAccess(actorOf('editor'), boardId, 'editor'))).toBe(200)
      expect(status(() => access.requireBoardAccess(actorOf('boardAdmin'), boardId, 'admin'))).toBe(200)
    })

    it('returns the actor alongside the account it resolved from', () => {
      const actor = actorOf('editor')
      const resolved = access.requireBoardAccess(actor, boardId)
      expect(resolved.actor).toBe(actor)
      expect(resolved.account.id).toBe(actor.principalId)
    })
  })

  describe('requireTicketAccess', () => {
    it('resolves through the ticket to its board', () => {
      expect(access.requireTicketAccess(actorOf('viewer'), ticketId).ticket.id).toBe(ticketId)
      expect(status(() => access.requireTicketAccess(actorOf('viewer'), ticketId, 'editor'))).toBe(403)
      expect(status(() => access.requireTicketAccess(actorOf('stranger'), ticketId))).toBe(404)
    })

    it('hides an archived ticket from everyone below board admin', () => {
      // Gone rather than forbidden: keeping the id is not a way to keep reading it.
      expect(status(() => access.requireTicketAccess(actorOf('viewer'), archivedTicketId))).toBe(404)
      expect(status(() => access.requireTicketAccess(actorOf('editor'), archivedTicketId))).toBe(404)
    })

    it('still shows an archived ticket to the admins who own the archive', () => {
      expect(status(() => access.requireTicketAccess(actorOf('boardAdmin'), archivedTicketId))).toBe(200)
      expect(status(() => access.requireTicketAccess(actorOf('owner'), archivedTicketId))).toBe(200)
    })

    it('answers an unknown ticket id with 404', () => {
      expect(status(() => access.requireTicketAccess(actorOf('owner'), 'no-such-ticket'))).toBe(404)
    })
  })

  describe('requireCommentAccess', () => {
    let editorComment = ''

    beforeAll(() => {
      editorComment = db.createComment(ticketId, people.editor!, 'Written by the editor', actorOf('editor'))!.id
    })

    it('lets the author change their own comment', () => {
      expect(status(() => access.requireCommentAccess(actorOf('editor'), editorComment))).toBe(200)
    })

    it('lets a board admin clear out somebody else’s', () => {
      expect(status(() => access.requireCommentAccess(actorOf('boardAdmin'), editorComment))).toBe(200)
    })

    it('refuses another member who is neither author nor admin', () => {
      expect(status(() => access.requireCommentAccess(actorOf('viewer'), editorComment))).toBe(403)
    })

    it('hides the comment entirely from someone who cannot see the board', () => {
      expect(status(() => access.requireCommentAccess(actorOf('stranger'), editorComment))).toBe(404)
    })
  })

  describe('requireInstanceAdmin', () => {
    it('admits owners and admins', () => {
      expect(access.requireInstanceAdmin(actorOf('owner')).role).toBe('owner')
      expect(access.requireInstanceAdmin(actorOf('admin')).role).toBe('admin')
    })

    it('refuses a member, however senior their board role', () => {
      expect(status(() => access.requireInstanceAdmin(actorOf('boardAdmin')))).toBe(403)
    })
  })

  /**
   * The guarantee the whole Actor split exists for. An agent carries provenance, not power:
   * naming one must not change a single answer above.
   */
  describe('an agent never widens what its principal may do', () => {
    const viaAgent = (who: string) =>
      actorModule.actorFor(db.findUser(people[who]!)!, { channel: 'mcp', agentId: 'claude-desktop', tokenId: 'tok_1' })

    it('leaves every board answer identical', () => {
      for (const who of ['owner', 'boardAdmin', 'editor', 'viewer', 'stranger']) {
        for (const minimum of boardRoles) {
          expect(status(() => access.requireBoardAccess(viaAgent(who), boardId, minimum)))
            .toBe(status(() => access.requireBoardAccess(actorOf(who), boardId, minimum)))
        }
      }
    })

    it('leaves the archive rule identical', () => {
      for (const who of ['boardAdmin', 'editor', 'viewer']) {
        expect(status(() => access.requireTicketAccess(viaAgent(who), archivedTicketId)))
          .toBe(status(() => access.requireTicketAccess(actorOf(who), archivedTicketId)))
      }
    })

    it('cannot make a non-admin into an instance admin', () => {
      expect(status(() => access.requireInstanceAdmin(viaAgent('editor')))).toBe(403)
    })

    it('carries the provenance through to the caller unchanged', () => {
      const resolved = access.requireBoardAccess(viaAgent('editor'), boardId)
      expect(resolved.actor).toMatchObject({ agentId: 'claude-desktop', tokenId: 'tok_1', channel: 'mcp' })
      expect(resolved.account.id).toBe(people.editor)
    })
  })
})
