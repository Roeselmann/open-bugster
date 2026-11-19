import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('the operation registry', () => {
  let db: typeof import('../server/utils/db')
  let audit: typeof import('../server/utils/audit')
  let actorModule: typeof import('../server/utils/actor')
  let ops: typeof import('../server/operations')
  let invite: typeof import('../server/utils/invite')
  let password: typeof import('../server/utils/password')

  let boardId = ''
  let laneId = ''
  const people: Record<string, string> = {}

  const actorOf = (who: string) => actorModule.actorFor(db.findUser(people[who]!)!)
  const agentOf = (who: string) =>
    actorModule.actorFor(db.findUser(people[who]!)!, { channel: 'mcp', agentId: 'claude-desktop', tokenId: 'tok_3' })

  const statusOf = async (promise: Promise<unknown>) => {
    try {
      await promise
      return 200
    } catch (error) {
      return (error as { statusCode?: number }).statusCode ?? 500
    }
  }

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-operations-'))
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
    invite = await import('../server/utils/invite')
    password = await import('../server/utils/password')

    people.owner = db.listUsers()[0]!.id
    for (const who of ['editor', 'viewer', 'stranger']) {
      people[who] = db.createUser({ email: `${who}@example.com`, firstName: who, lastName: 'T', role: 'member' }).id
    }
    const board = db.listBoards()[0]!
    boardId = board.id
    laneId = board.lanes.find(lane => !lane.isImport)!.id
    // This board is worked through tokens further down, so it permits automation.
    db.setBoardMember(boardId, people.editor!, 'editor', true)
    db.setBoardMember(boardId, people.viewer!, 'viewer', true)
  })

  describe('shape', () => {
    it('registers every operation under a unique dotted name', () => {
      expect(ops.operations.size).toBeGreaterThan(20)
      for (const [name, operation] of ops.operations) {
        // Two segments, or three for a nested family like `workspace.member.set`; camel case
        // only ever in the final verb.
        expect(name).toMatch(/^[a-z]+(\.[a-z]+)?\.[a-zA-Z]+$/)
        // The key and the operation's own name are the same published identifier.
        expect(operation.name).toBe(name)
      }
    })

    it('finds an operation by name and nothing by a made-up one', () => {
      expect(ops.findOperation('ticket.move')?.name).toBe('ticket.move')
      expect(ops.findOperation('ticket.teleport')).toBeNull()
    })
  })

  describe('validation happens before anything else', () => {
    it('refuses bad input with 422 without touching access', async () => {
      // A stranger would get 404 from the guard; the 422 proves the schema ran first.
      expect(await statusOf(ops.run(ops.ticketCreate, actorOf('stranger'), { boardId, title: '' }))).toBe(422)
    })

    it('applies the schema’s defaults', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Defaults', laneId }) as { ticket: { priority: string; description: string } }
      expect(ticket.priority).toBe('medium')
      expect(ticket.description).toBe('')
    })

    it('puts a ticket at the top of its lane when the placement says so', async () => {
      const { ticket: below } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Below', laneId }) as { ticket: { id: string; position: number } }
      const { ticket: top } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Top', laneId, placement: 'top' }) as { ticket: { id: string; position: number } }
      expect(top.position).toBe(0)
      expect(db.findTicket(below.id)!.position).toBe(below.position + 1)
      expect(await statusOf(ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Nope', laneId, placement: 'middle' }))).toBe(422)
    })
  })

  describe('access is resolved from the requirement', () => {
    it('keeps the board rules the guards already enforced', async () => {
      expect(await statusOf(ops.run(ops.ticketCreate, actorOf('viewer'), { boardId, title: 'Nope', laneId }))).toBe(403)
      expect(await statusOf(ops.run(ops.ticketCreate, actorOf('stranger'), { boardId, title: 'Nope', laneId }))).toBe(404)
      expect(await statusOf(ops.run(ops.boardCreate, actorOf('editor'), { name: 'Nope' }))).toBe(403)
    })

    it('resolves a ticket-scoped operation through to its board', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Scoped', laneId }) as { ticket: { id: string } }
      expect(await statusOf(ops.run(ops.ticketGet, actorOf('viewer'), { ticketId: ticket.id }))).toBe(200)
      expect(await statusOf(ops.run(ops.ticketMove, actorOf('viewer'), { ticketId: ticket.id, laneId, index: 0 }))).toBe(403)
    })

    it('asks for editing rights on both boards when a ticket moves between them', async () => {
      const other = db.createBoard('Other app')
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Crossing', laneId }) as { ticket: { id: string } }
      // Invisible destination: the same 404 a stranger gets everywhere.
      expect(await statusOf(ops.run(ops.ticketTransfer, actorOf('editor'), { ticketId: ticket.id, boardId: other.id }))).toBe(404)
      db.setBoardMember(other.id, people.editor!, 'viewer', false)
      expect(await statusOf(ops.run(ops.ticketTransfer, actorOf('editor'), { ticketId: ticket.id, boardId: other.id }))).toBe(403)
      expect(await statusOf(ops.run(ops.ticketTransfer, actorOf('editor'), { ticketId: ticket.id, boardId }))).toBe(409)
      db.setBoardMember(other.id, people.editor!, 'editor', false)
      const moved = await ops.run(ops.ticketTransfer, actorOf('editor'), { ticketId: ticket.id, boardId: other.id }) as { ticket: { boardId: string }; assigneeCleared: boolean }
      expect(moved.ticket.boardId).toBe(other.id)
      expect(moved.assigneeCleared).toBe(false)
      expect(audit.listAudit({ operation: 'ticket.transfer' })[0]).toMatchObject({ targetId: ticket.id, changes: { boardId: other.id } })
      db.deleteBoard(other.id)
    })

    it('keeps a start date beside the due date, never after it', async () => {
      type Result = { ticket: { id: string; startDate: string | null; dueDate: string | null } }
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Spans days', laneId, startDate: '2026-03-03', dueDate: '2026-03-14' }) as Result
      expect(ticket).toMatchObject({ startDate: '2026-03-03', dueDate: '2026-03-14' })
      expect(await statusOf(ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Backwards', laneId, startDate: '2026-03-15', dueDate: '2026-03-14' }))).toBe(422)
      // Checked as the span will stand: a new start against the due date already set.
      expect(await statusOf(ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: ticket.id, startDate: '2026-03-20' }))).toBe(422)
      expect(await statusOf(ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: ticket.id, dueDate: '2026-03-01' }))).toBe(422)
      // Moving both together is fine, and so is a milestone: start and due on the same day.
      const moved = await ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: ticket.id, startDate: '2026-03-20', dueDate: '2026-03-20' }) as Result
      expect(moved.ticket).toMatchObject({ startDate: '2026-03-20', dueDate: '2026-03-20' })
      const cleared = await ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: ticket.id, startDate: null }) as Result
      expect(cleared.ticket.startDate).toBeNull()
      expect(db.listActivity(ticket.id).filter(entry => entry.kind === 'start_date').map(entry => entry.payload.to)).toEqual([null, '2026-03-20'])
    })

    it('keeps a live window apart from the work, and a live lane quiets the due date', async () => {
      type Result = { ticket: { id: string; liveFrom: string | null; liveUntil: string | null } }
      const board = db.createBoard('Campaign board')
      db.setBoardMember(board.id, people.editor!, 'editor', false)
      const lanes = db.findBoardSummary(board.id)!.lanes.filter(lane => !lane.isImport)
      const work = lanes[0]!
      const live = lanes[1]!

      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId: board.id, laneId: work.id, title: 'Launch', dueDate: '2026-01-18', liveFrom: '2026-01-18', liveUntil: '2026-07-31' }) as Result
      expect(ticket).toMatchObject({ liveFrom: '2026-01-18', liveUntil: '2026-07-31' })
      expect(await statusOf(ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: ticket.id, liveUntil: '2026-01-01' }))).toBe(422)

      // Live and done exclude each other; the import lane is neither.
      db.updateLane(live.id, { isLive: true })
      const doneLane = lanes.find(lane => lane.isDone)!
      expect(db.findLane(live.id)).toMatchObject({ isLive: true, isDone: false })
      db.updateLane(live.id, { isDone: true })
      expect(db.findLane(live.id)).toMatchObject({ isLive: false, isDone: true })
      db.updateLane(live.id, { isLive: true })
      expect(db.findLane(doneLane.id)!.isDone).toBe(true)

      // Overdue while worked on; quiet once live, and done as a subticket.
      const owner = { userId: people.owner!, instanceAdmin: true }
      expect(db.listDueTickets(owner as never, '2026-03-01').some(due => due.id === ticket.id)).toBe(true)
      const parent = db.createTicket(board.id, { title: 'Bundle', laneId: work.id, todos: [{ text: '', completed: false, subticketId: ticket.id }] })!
      db.moveTicket(ticket.id, live.id, 0)
      expect(db.listDueTickets(owner as never, '2026-03-01').some(due => due.id === ticket.id)).toBe(false)
      expect(db.findTicket(parent.id)!.todos[0]).toMatchObject({ completed: true, subticket: { done: true } })

      const { timelineWarnings } = await import('../shared/utils/timeline')
      const tree = db.ticketTimeline(parent.id, () => true)!
      expect(tree.children[0]).toMatchObject({ live: true, done: true, liveUntil: '2026-07-31' })
      expect(timelineWarnings(tree, '2026-03-01')).toEqual([])
      expect(timelineWarnings(tree, '2026-08-02').map(warning => warning.kind)).toEqual(['live_ended'])
      db.deleteBoard(board.id)
    })

    it('reads a ticket and its subtickets down through theirs as a timeline', async () => {
      type Node = { ticketNumber: number; title: string; startDate: string | null; readable: boolean; children: Node[] }
      const design = db.createBoard('Production')
      const review = db.createBoard('Review')
      db.setBoardMember(design.id, people.editor!, 'editor', false)
      db.setBoardMember(review.id, people.editor!, 'editor', false)
      const firstLane = (id: string) => db.findBoardSummary(id)!.lanes.find(lane => !lane.isImport)!.id
      const plan = db.createTicket(boardId, { title: 'Launch plan', startDate: '2026-03-01', dueDate: '2026-04-30' })!
      const asset = db.createSubticket(plan.id, { boardId: design.id, laneId: firstLane(design.id), title: 'Email' }, null)!.subticket
      const fragment = db.createSubticket(asset.id, { boardId: design.id, laneId: firstLane(design.id), title: 'Fragment' }, null)!.subticket
      const check = db.createSubticket(fragment.id, { boardId: review.id, laneId: firstLane(review.id), title: 'MLR' }, null)!.subticket
      db.createSubticket(check.id, { boardId: review.id, laneId: firstLane(review.id), title: 'Second round' }, null)
      db.updateTicket(asset.id, { startDate: '2026-03-10', dueDate: '2026-05-04' })
      const archived = db.createSubticket(plan.id, { boardId, laneId, title: 'Dropped' }, null)!.subticket
      db.archiveTicket(archived.id)

      const read = async () => (await ops.run(ops.ticketTimelineGet, actorOf('editor'), { ticketId: plan.id }) as { timeline: Node }).timeline
      const tree = await read()
      expect(tree.title).toBe('Launch plan')
      expect(tree.children.map(node => node.title)).toEqual(['Email'])
      expect(tree.children[0]!.children[0]!.children[0]!.children[0]!.title).toBe('Second round')

      // A board out of reach still shows its ticket, as the to-do list does, but not below it.
      db.removeBoardMember(review.id, people.editor!)
      const partial = await read()
      const hidden = partial.children[0]!.children[0]!.children[0]!
      expect(hidden).toMatchObject({ title: 'MLR', readable: false, children: [] })

      const { timelineWarnings } = await import('../shared/utils/timeline')
      expect(timelineWarnings(tree as never, '2026-03-05').map(warning => warning.kind)).toEqual(['ends_after_plan'])
      db.deleteBoard(design.id)
      db.deleteBoard(review.id)
    })

    it('lists where a ticket is used: its parents on boards the caller can read', async () => {
      type Parents = { parents: Array<{ ticketNumber: number; title: string; archived: boolean }> }
      const other = db.createBoard('Elsewhere')
      db.setBoardMember(other.id, people.editor!, 'editor', false)
      const otherLane = db.findBoardSummary(other.id)!.lanes.find(lane => !lane.isImport)!.id
      const mail = db.createTicket(boardId, { title: 'Start mail', laneId })!
      const fragment = db.createSubticket(mail.id, { boardId, laneId, title: 'Shared fragment' }, null)!.subticket
      db.createTicket(other.id, { title: 'Follow-up', laneId: otherLane, todos: [{ text: '', completed: false, subticketId: fragment.id }] })!
      const dropped = db.createTicket(boardId, { title: 'Dropped mail', laneId, todos: [{ text: '', completed: false, subticketId: fragment.id }] })!
      db.archiveTicket(dropped.id)

      const read = async () => (await ops.run(ops.ticketParentsList, actorOf('editor'), { ticketId: fragment.id }) as Parents).parents
      expect((await read()).map(parent => [parent.title, parent.archived])).toEqual([['Start mail', false], ['Follow-up', false], ['Dropped mail', true]])
      // A parent on a board out of reach is not there at all, not even its number.
      db.removeBoardMember(other.id, people.editor!)
      expect((await read()).map(parent => parent.title)).toEqual(['Start mail', 'Dropped mail'])
      expect(await ops.run(ops.ticketParentsList, actorOf('editor'), { ticketId: mail.id })).toEqual({ parents: [] })
      db.deleteBoard(other.id)
    })

    it('files a subticket on another board of the workspace and ticks it from its lane', async () => {
      type Todo = { text: string; completed: boolean; subticketId: string | null; subticket: { ticketNumber: number; boardName: string; laneName: string; done: boolean } | null }
      type Result = { ticket: { id: string; todos: Todo[] }; subticket: { id: string; boardId: string; laneId: string; ticketNumber: number } }
      const other = db.createBoard('Design')
      const otherLanes = db.findBoardSummary(other.id)!.lanes
      const startLane = otherLanes.find(lane => !lane.isImport && !lane.isDone)!
      const doneLane = otherLanes.find(lane => lane.isDone)!
      const { ticket: parent } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Parent', laneId, todos: [{ text: 'Plain', completed: true }] }) as { ticket: { id: string } }
      const input = { ticketId: parent.id, boardId: other.id, laneId: startLane.id, title: 'Mockups', description: 'Two variants' }

      // The destination is checked like a transfer: invisible is 404, read-only is 403.
      expect(await statusOf(ops.run(ops.ticketSubticketCreate, actorOf('editor'), input))).toBe(404)
      db.setBoardMember(other.id, people.editor!, 'viewer', false)
      expect(await statusOf(ops.run(ops.ticketSubticketCreate, actorOf('editor'), input))).toBe(403)
      db.setBoardMember(other.id, people.editor!, 'editor', false)
      // A lane of some other board is refused rather than quietly replaced.
      expect(await statusOf(ops.run(ops.ticketSubticketCreate, actorOf('editor'), { ...input, laneId }))).toBe(422)

      const created = await ops.run(ops.ticketSubticketCreate, actorOf('editor'), input) as Result
      expect(created.subticket).toMatchObject({ boardId: other.id, laneId: startLane.id })
      expect(db.findTicket(created.subticket.id)!.description).toBe('Two variants')
      // Typed like a ticket filed from the board: the workspace's "Ticket".
      expect(db.findTicket(created.subticket.id)!.type?.name).toBe('Ticket')
      expect(created.ticket.todos.map(todo => [todo.text, todo.completed, todo.subticketId])).toEqual([['Plain', true, null], ['Mockups', false, created.subticket.id]])
      expect(created.ticket.todos[1]!.subticket).toMatchObject({ ticketNumber: created.subticket.ticketNumber, boardName: 'Design', laneName: startLane.name, done: false })

      // Reaching a done lane ticks it, and a renamed subticket is renamed in the list.
      db.moveTicket(created.subticket.id, doneLane.id, 0)
      db.updateTicket(created.subticket.id, { title: 'Final mockups' })
      expect(db.findTicket(parent.id)!.todos[1]).toMatchObject({ text: 'Final mockups', completed: true, subticket: { done: true, laneName: doneLane.name } })

      // Sending the list back keeps it, whatever flag or text the caller claims; leaving it out unlinks it.
      const kept = await ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: parent.id, todos: [{ text: 'Whatever', completed: false, subticketId: created.subticket.id }, { text: 'Plain', completed: true }] }) as Result
      expect(kept.ticket.todos.map(todo => [todo.text, todo.completed, todo.subticketId])).toEqual([['Final mockups', true, created.subticket.id], ['Plain', true, null]])
      // Naming itself or a ticket that already lists it is refused.
      expect(await statusOf(ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: parent.id, todos: [{ text: 'x', subticketId: parent.id }] }))).toBe(422)
      const { ticket: grand } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Lists the parent', laneId, todos: [{ text: 'Parent', subticketId: parent.id }] }) as { ticket: { id: string; todos: Todo[] } }
      expect(grand.todos[0]!.subticketId).toBe(parent.id)
      expect(await statusOf(ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: parent.id, todos: [{ text: 'x', subticketId: grand.id }] }))).toBe(422)
      const unlinked = await ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: parent.id, todos: [{ text: 'Plain', completed: true }] }) as Result
      expect(unlinked.ticket.todos.map(todo => todo.subticketId)).toEqual([null])
      expect(db.findTicket(created.subticket.id)).not.toBeNull()

      // Another workspace is out of reach, even for somebody who may edit there.
      const elsewhere = db.createBoard('Elsewhere', null, db.createWorkspace('Other company').id)
      db.setBoardMember(elsewhere.id, people.editor!, 'editor', false)
      const elsewhereLane = db.findBoardSummary(elsewhere.id)!.lanes.find(lane => !lane.isImport)!
      expect(await statusOf(ops.run(ops.ticketSubticketCreate, actorOf('editor'), { ...input, boardId: elsewhere.id, laneId: elsewhereLane.id }))).toBe(422)
      db.deleteBoard(elsewhere.id)
      db.deleteBoard(other.id)
      expect(db.findTicket(parent.id)!.todos).toHaveLength(1)
    })

    it('finds existing tickets of the workspace and links one as a subticket', async () => {
      type Ref = { id: string; ticketNumber: number; boardName: string }
      const other = db.createBoard('Marketing')
      const otherLane = db.findBoardSummary(other.id)!.lanes.find(lane => !lane.isImport)!
      const { ticket: parent } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Campaign', laneId }) as { ticket: { id: string } }
      const { ticket: here } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Banner 100% done_ish', laneId }) as { ticket: { id: string; ticketNumber: number } }
      const there = db.createTicket(other.id, { title: 'Banner copy', laneId: otherLane.id })!
      const search = async (query: string) => (await ops.run(ops.ticketSubticketCandidates, actorOf('editor'), { ticketId: parent.id, query }) as { candidates: Ref[] }).candidates

      // Only boards the caller can read count; the parent itself never shows.
      expect((await search('banner')).map(ref => ref.id)).toEqual([here.id])
      db.setBoardMember(other.id, people.editor!, 'viewer', false)
      expect((await search('banner')).map(ref => ref.id).sort()).toEqual([here.id, there.id].sort())
      expect((await search('Campaign')).map(ref => ref.id)).toEqual([])
      // A number finds its ticket, with or without the hash; LIKE wildcards are taken literally.
      expect((await search(`#${there.ticketNumber}`))[0]).toMatchObject({ id: there.id, boardName: 'Marketing' })
      expect((await search('100%')).map(ref => ref.id)).toEqual([here.id])
      expect((await search('_ish')).map(ref => ref.id)).toEqual([here.id])
      // A viewer of the parent may not link anything to it.
      expect(await statusOf(ops.run(ops.ticketSubticketCandidates, actorOf('viewer'), { ticketId: parent.id, query: '' }))).toBe(403)

      // Linking is naming it in the list; a read-only membership on its board is enough.
      const linked = await ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: parent.id, todos: [{ text: 'Banner copy', subticketId: there.id }] }) as { ticket: { todos: Array<{ subticketId: string | null; subticket: Ref | null }> } }
      expect(linked.ticket.todos[0]).toMatchObject({ subticketId: there.id, subticket: { boardName: 'Marketing' } })
      expect(db.listActivity(parent.id).map(entry => entry.kind)).toContain('subticket')
      // What is linked drops out of the candidates.
      expect((await search('banner')).map(ref => ref.id)).toEqual([here.id])

      // A ticket the caller cannot see is a 404, like everywhere else.
      db.removeBoardMember(other.id, people.editor!)
      const hidden = db.createTicket(other.id, { title: 'Hidden', laneId: otherLane.id })!
      expect(await statusOf(ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: parent.id, todos: [{ text: 'x', subticketId: hidden.id }] }))).toBe(404)
      db.deleteBoard(other.id)
    })

    it('checks a ticket number against the ticket it names, not the caller', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Numbered', laneId }) as { ticket: { id: string; ticketNumber: number } }
      expect(await statusOf(ops.run(ops.ticketGetByNumber, actorOf('viewer'), { ticketNumber: ticket.ticketNumber }))).toBe(200)
      // A number is a global handle, so it must not become a way to read across boards. A
      // stranger gets the same 404 as for a number that was never issued — no existence leak.
      expect(await statusOf(ops.run(ops.ticketGetByNumber, actorOf('stranger'), { ticketNumber: ticket.ticketNumber }))).toBe(404)
      expect(await statusOf(ops.run(ops.ticketGetByNumber, actorOf('viewer'), { ticketNumber: 999_999 }))).toBe(404)
    })

    it('checks an attachment against the board of the ticket holding it', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'With a file', laneId }) as { ticket: { id: string } }
      const attachmentId = db.addAttachment(ticket.id, 'file', 'shot.png', 'image/png', 11, `${ticket.id}/shot.png`)
      // An attachment id names a file with no board and no ticket in the request, so the
      // check has to reach the owning ticket itself rather than trust what was asked for.
      expect(await statusOf(ops.run(ops.attachmentGet, actorOf('viewer'), { attachmentId }))).toBe(200)
      expect(await statusOf(ops.run(ops.attachmentGet, actorOf('stranger'), { attachmentId }))).toBe(404)
      expect(await statusOf(ops.run(ops.attachmentGet, actorOf('viewer'), { attachmentId: 'att_nope' }))).toBe(404)
    })

    it('takes a file in and gives the same file back', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Round trip', laneId }) as { ticket: { id: string } }
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')])
      const { attachment } = await ops.run(ops.attachmentAdd, actorOf('editor'), {
        ticketId: ticket.id, filename: 'shot.png', mimeType: 'image/png', content: png.toString('base64')
      }) as { attachment: { id: string; size: number; mimeType: string; url: string } }

      expect(attachment).toMatchObject({ size: png.length, mimeType: 'image/png' })
      // The url points at the surface a token can actually reach, not the UI's own path.
      expect(attachment.url).toBe(`/api/v1/attachments/${attachment.id}`)

      const stored = await ops.run(ops.attachmentGet, actorOf('viewer'), { attachmentId: attachment.id }) as { attachment: { relative_path: string } }
      const file = await import('../server/utils/attachment-file')
      const onDisk = await readFile(await file.resolveAttachmentFile(stored.attachment.relative_path))
      expect(onDisk.equals(png)).toBe(true)
    })

    it('holds an upload to the same policy the browser goes through', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Policed', laneId }) as { ticket: { id: string } }
      const upload = (input: Record<string, unknown>) => ops.run(ops.attachmentAdd, actorOf('editor'), { ticketId: ticket.id, ...input })

      // Claims to be a PNG, is not one. Decoding base64 is lenient, so this is the check that
      // stops a body that was never really a file.
      expect(await statusOf(upload({ filename: 'fake.png', mimeType: 'image/png', content: Buffer.from('<html>').toString('base64') }))).toBe(422)
      expect(await statusOf(upload({ filename: 'evil.svg', content: Buffer.from('<svg/>').toString('base64') }))).toBe(422)
      // Viewers read a board; attaching to it is an editor's.
      expect(await statusOf(ops.run(ops.attachmentAdd, actorOf('viewer'), {
        ticketId: ticket.id, filename: 'note.txt', content: Buffer.from('hi').toString('base64')
      }))).toBe(403)
    })

    it('refuses to attach to a ticket that has left the board', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Gone', laneId }) as { ticket: { id: string } }
      await ops.run(ops.ticketArchive, actorOf('owner'), { ticketId: ticket.id })
      expect(await statusOf(ops.run(ops.attachmentAdd, actorOf('owner'), {
        ticketId: ticket.id, filename: 'note.txt', content: Buffer.from('too late').toString('base64')
      }))).toBe(409)
    })

    it('an agent still cannot exceed its principal', async () => {
      expect(await statusOf(ops.run(ops.ticketCreate, agentOf('viewer'), { boardId, title: 'Nope', laneId }))).toBe(403)
      expect(await statusOf(ops.run(ops.boardCreate, agentOf('editor'), { name: 'Nope' }))).toBe(403)
    })

    it('reads a lane operation’s board from the input rather than the lane', async () => {
      // A lane belonging to another board must not be reachable by naming this one.
      const other = db.createBoard('Other board')
      const foreignLane = other.lanes[0]!.id
      expect(await statusOf(ops.run(ops.laneUpdate, actorOf('owner'), { boardId, laneId: foreignLane, name: 'Hijacked' }))).toBe(404)
    })
  })

  describe('audit by construction', () => {
    it('records a write without the operation asking', async () => {
      const before = audit.countAudit()
      const { ticket } = await ops.run(ops.ticketCreate, agentOf('editor'), { boardId, title: 'Audited', laneId, priority: 'high' }) as { ticket: { id: string } }
      expect(audit.countAudit()).toBe(before + 1)

      const entry = audit.listAudit({ operation: 'ticket.create' })[0]!
      expect(entry).toMatchObject({
        principalId: people.editor,
        agentId: 'claude-desktop',
        tokenId: 'tok_3',
        channel: 'mcp',
        targetType: 'ticket',
        targetId: ticket.id,
        boardId,
        result: 'ok'
      })
    })

    it('logs only the fields the operation named', async () => {
      await ops.run(ops.ticketCreate, actorOf('editor'), {
        boardId, laneId, title: 'Allowlist', priority: 'urgent',
        description: 'This body is long and has no business being in an audit entry.'
      })
      const entry = audit.listAudit({ operation: 'ticket.create' })[0]!
      expect(Object.keys(entry.changes).sort()).toEqual(['laneId', 'priority', 'title'])
      // A field nobody listed cannot reach the log, however sensitive it turns out to be.
      expect(entry.changes).not.toHaveProperty('description')
      expect(JSON.stringify(entry)).not.toContain('no business')
    })

    it('records a refusal, with no changes attached', async () => {
      await statusOf(ops.run(ops.ticketCreate, actorOf('viewer'), { boardId, title: 'Refused', laneId }))
      const entry = audit.listAudit({ operation: 'ticket.create' })[0]!
      expect(entry.result).toBe('denied')
      expect(entry.changes).toEqual({})
      expect(entry.principalId).toBe(people.viewer)
    })

    it('does not log a successful read, which would bury the writes', async () => {
      const before = audit.countAudit()
      await ops.run(ops.ticketList, actorOf('viewer'), { boardId })
      await ops.run(ops.boardList, actorOf('viewer'), {})
      expect(audit.countAudit()).toBe(before)
    })

    it('does log a refused read, which leaves no other trace', async () => {
      const before = audit.countAudit()
      await statusOf(ops.run(ops.ticketList, actorOf('stranger'), { boardId }))
      expect(audit.countAudit()).toBe(before + 1)
      expect(audit.listAudit({ operation: 'ticket.list' })[0]).toMatchObject({ result: 'denied', principalId: people.stranger })
    })

    it('logs a ticket update by which fields moved, not by their contents', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Editable', laneId }) as { ticket: { id: string } }
      await ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: ticket.id, title: 'Renamed', description: 'A very long description indeed.' })
      const entry = audit.listAudit({ operation: 'ticket.update' })[0]!
      expect(entry.changes).toEqual({ fields: ['description', 'title'] })
      expect(JSON.stringify(entry)).not.toContain('very long description')
    })

    it('takes only the ticket’s own images as the card image, and forgets a deleted one', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Two pictures', laneId }) as { ticket: { id: string } }
      const { ticket: other } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Elsewhere', laneId }) as { ticket: { id: string } }
      const first = db.addAttachment(ticket.id, 'file', 'first.png', 'image/png', 11, `${ticket.id}/first.png`)
      const second = db.addAttachment(ticket.id, 'file', 'second.png', 'image/png', 11, `${ticket.id}/second.png`)
      const log = db.addAttachment(ticket.id, 'file', 'crash.log', 'text/plain', 11, `${ticket.id}/crash.log`)
      const foreign = db.addAttachment(other.id, 'file', 'foreign.png', 'image/png', 11, `${other.id}/foreign.png`)
      const update = (coverAttachmentId: string | null) => ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: ticket.id, coverAttachmentId }) as Promise<{ ticket: { coverAttachmentId: string | null } }>

      expect(db.findTicket(ticket.id)?.coverAttachmentId).toBeNull()
      expect((await update(second)).ticket.coverAttachmentId).toBe(second)
      expect(await statusOf(update(log))).toBe(422)
      expect(await statusOf(update(foreign))).toBe(422)
      // An unrelated change keeps the pick.
      await ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: ticket.id, title: 'Renamed' })
      expect(db.findTicket(ticket.id)?.coverAttachmentId).toBe(second)

      db.deleteAttachment(second)
      expect(db.findTicket(ticket.id)?.coverAttachmentId).toBeNull()
      expect((await update(first)).ticket.coverAttachmentId).toBe(first)
      expect((await update(null)).ticket.coverAttachmentId).toBeNull()
    })

    it('puts several pictures on the card, attachments and rendered link previews alike', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), {
        boardId, title: 'Pictures and pages', laneId,
        links: [{ url: 'https://example.com/page', display: 'preview' }, { url: 'https://example.com/plain', display: 'text' }]
      }) as { ticket: { id: string, links: Array<{ id: string }> } }
      const [page, plain] = ticket.links as [{ id: string }, { id: string }]
      db.saveLinkPreview(page.id, { title: 'Page', description: null, siteName: null, imagePath: `${ticket.id}/link-page.jpg` })
      db.saveLinkPreview(plain.id, { title: 'Plain', description: null, siteName: null, imagePath: `${ticket.id}/link-plain.jpg` })
      const shot = db.addAttachment(ticket.id, 'file', 'shot.png', 'image/png', 11, `${ticket.id}/shot.png`)
      const update = (cardImageIds: string[] | null) => ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: ticket.id, cardImageIds }) as Promise<{ ticket: { cardImageIds: string[] | null, coverAttachmentId: string | null } }>

      expect(db.findTicket(ticket.id)?.cardImageIds).toBeNull()
      expect((await update([page.id, shot])).ticket).toMatchObject({ cardImageIds: [page.id, shot], coverAttachmentId: shot })
      // A link shown as text offers no picture, whatever it once rendered.
      expect(await statusOf(update([plain.id]))).toBe(422)
      expect(await statusOf(update(['somebody-else']))).toBe(422)
      expect((await update([])).ticket.cardImageIds).toEqual([])
      // The older single pick still works, as a pick of one.
      const single = await ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: ticket.id, coverAttachmentId: shot }) as { ticket: { cardImageIds: string[] | null } }
      expect(single.ticket.cardImageIds).toEqual([shot])

      // Once every picked picture is gone the card goes back to the default, not to nothing.
      db.deleteAttachment(shot)
      expect(db.findTicket(ticket.id)?.cardImageIds).toBeNull()
    })

    /**
     * The guarantee the registry exists for. If this ever fails, somebody has added a write
     * that the audit log cannot see.
     */
    it('leaves no mutating operation unaudited', () => {
      const unaudited = [...ops.operations.values()]
        .filter(operation => operation.audit === false)
        .map(operation => operation.name)
      // Everything left is a read; the naming convention is what makes that checkable. A write
      // that does not end in one of these words fails here, which is the point. `get` and
      // `list` may carry a qualifier for how the subject is named — `getByNumber` — because
      // that changes the lookup and never the verb; nothing that mutates is named `getX`.
      expect(unaudited.every(name => /\.((list|get)([A-Z]\w*)?|activity|status|candidates|deliveries)$/.test(name)), unaudited.join(', ')).toBe(true)
    })
  })

  /**
   * The routes that were left calling `db.ts` directly until now. Role changes, invitations
   * and account deletions are exactly what an audit log is for, and they were invisible to it.
   */
  describe('account administration', () => {
    it('audits a role change by value, and a rename by field name only', async () => {
      const target = db.createUser({ email: 'promoted@example.com', firstName: 'Pat', lastName: 'R', role: 'member' })

      await ops.run(ops.userUpdate, actorOf('owner'), { userId: target.id, role: 'admin' })
      expect(audit.listAudit({ operation: 'user.update' })[0]!.changes).toEqual({ fields: ['role'], role: 'admin' })

      await ops.run(ops.userUpdate, actorOf('owner'), { userId: target.id, firstName: 'Patricia' })
      const renamed = audit.listAudit({ operation: 'user.update' })[0]!
      expect(renamed.changes).toEqual({ fields: ['firstName'] })
      // A name in the log would survive anonymizing the person it names.
      expect(JSON.stringify(renamed)).not.toContain('Patricia')
    })

    it('keeps the owner and the caller’s own account out of reach', async () => {
      const self = db.findUser(people.owner!)!
      expect(await statusOf(ops.run(ops.userUpdate, actorOf('owner'), { userId: self.id, role: 'member' }))).toBe(409)
      expect(await statusOf(ops.run(ops.userDelete, actorOf('owner'), { userId: self.id }))).toBe(409)
      expect(await statusOf(ops.run(ops.userAnonymize, actorOf('owner'), { userId: self.id }))).toBe(409)
    })

    it('is closed to anyone who is not an instance admin', async () => {
      expect(await statusOf(ops.run(ops.userList, actorOf('editor'), {}))).toBe(403)
      expect(await statusOf(ops.run(ops.userCreate, agentOf('editor'), { email: 'x@example.com', firstName: 'X', lastName: 'Y', role: 'member' }))).toBe(403)
    })

    it('never lets an invite token reach the log', async () => {
      const { user, inviteToken } = await ops.run(ops.userCreate, actorOf('owner'), {
        email: 'invited@example.com', firstName: 'In', lastName: 'Vited', role: 'member'
      }) as { user: { id: string }; inviteToken: string }

      expect(inviteToken).toMatch(/^[A-Za-z0-9_-]{20,}$/)
      const entry = audit.listAudit({ operation: 'user.create' })[0]!
      expect(entry.targetId).toBe(user.id)
      expect(entry.changes).toEqual({ role: 'member' })
      // Neither the token nor the address the account was opened under.
      expect(JSON.stringify(entry)).not.toContain(inviteToken)
      expect(JSON.stringify(entry)).not.toContain('invited@example.com')
    })

    it('hands back a token an administrator can turn into a link, and can revoke it', async () => {
      const target = db.findUserByEmail('invited@example.com')!
      const { inviteToken, purpose } = await ops.run(ops.userInvite, actorOf('owner'), { userId: target.id }) as { inviteToken: string; purpose: string }
      expect(purpose).toBe('invite')
      // The operation returns the raw token; only the transport knows what origin to put it on.
      expect(db.findUserByInviteToken(invite.hashInviteToken(inviteToken))?.id).toBe(target.id)

      await ops.run(ops.userRevokeInvite, actorOf('owner'), { userId: target.id })
      expect(db.findUserByInviteToken(invite.hashInviteToken(inviteToken))).toBeNull()
    })

    it('refuses a link for a disabled account', async () => {
      const target = db.findUserByEmail('invited@example.com')!
      db.updateUser(target.id, { status: 'disabled' })
      expect(await statusOf(ops.run(ops.userInvite, actorOf('owner'), { userId: target.id }))).toBe(409)
    })
  })

  describe('secrets never reach the audit log', () => {
    it('records a password change without anything derived from the password', async () => {
      const person = db.createUser({ email: 'pw@example.com', firstName: 'P', lastName: 'W', role: 'member' })
      db.setUserPassword(person.id, password.hashStoredPassword('the-old-password-here'))
      const self = actorModule.actorFor(db.findUser(person.id)!)

      expect(await statusOf(ops.run(ops.profileChangePassword, self, { currentPassword: 'wrong-password-here', newPassword: 'a-brand-new-password' }))).toBe(401)
      await ops.run(ops.profileChangePassword, self, { currentPassword: 'the-old-password-here', newPassword: 'a-brand-new-password' })

      for (const entry of audit.listAudit({ operation: 'profile.changePassword' })) {
        expect(entry.changes).toEqual({})
        const text = JSON.stringify(entry)
        expect(text).not.toContain('the-old-password-here')
        expect(text).not.toContain('a-brand-new-password')
      }
    })

    it('records an attachment by filename and never by its bytes', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Has a file', laneId }) as { ticket: { id: string } }
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('RECOGNISABLE-PIXELS')])
      await ops.run(ops.attachmentAdd, actorOf('editor'), {
        ticketId: ticket.id, filename: 'shot.png', mimeType: 'image/png', content: png.toString('base64')
      })

      const entry = audit.listAudit({ operation: 'attachment.add' })[0]!
      expect(entry.changes).toMatchObject({ filename: 'shot.png' })
      // A 20 MB file in the log would bury everything worth finding, quite apart from what
      // it might contain. The allowlist is what keeps it out.
      expect(JSON.stringify(entry)).not.toContain('RECOGNISABLE-PIXELS')
      expect(JSON.stringify(entry)).not.toContain(png.toString('base64'))
    })

    it('records a key upload by filename and never by its contents', async () => {
      const pem = '-----BEGIN PRIVATE KEY-----\nSUPERSECRETKEYMATERIAL\n-----END PRIVATE KEY-----'
      await ops.run(ops.boardKeySet, actorOf('owner'), { boardId, filename: 'AuthKey_ABC123.p8', pem })

      const entry = audit.listAudit({ operation: 'board.setKey' })[0]!
      expect(entry.changes).toEqual({ filename: 'AuthKey_ABC123.p8' })
      // The allowlist is what makes this true, rather than anybody having remembered.
      expect(JSON.stringify(entry)).not.toContain('SUPERSECRETKEYMATERIAL')
      expect(JSON.stringify(entry)).not.toContain('PRIVATE KEY')
    })
  })

  describe('the operations behave as the routes did', () => {
    it('refuses to assign a ticket to somebody who is not on the board', async () => {
      expect(await statusOf(ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Bad assignee', laneId, assigneeId: people.stranger }))).toBe(422)
    })

    it('keeps attribution with the board admins, on the tickets that have it', async () => {
      const importLane = db.listLanes(boardId).find(lane => lane.isImport)!
      const imported = db.insertImportedTicket({
        boardId, laneId: importLane.id, externalId: 'feedback-1', type: 'screenshot',
        title: 'Reported from TestFlight', comment: 'It crashed', testerEmail: 'tester@example.com',
        deviceModel: null, osVersion: null, locale: null, buildId: null, buildVersion: null,
        buildBundleId: null, sourceCreatedAt: new Date().toISOString(), raw: {}
      })

      // An imported ticket arrives unattributed, and naming who really filed it is an
      // admin's call rather than any editor's.
      expect(await statusOf(ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: imported.id, authorId: people.editor }))).toBe(403)
      expect(await statusOf(ops.run(ops.ticketUpdate, actorOf('owner'), { ticketId: imported.id, authorId: people.editor }))).toBe(200)
      // Somebody who is not on the board cannot be named either.
      expect(await statusOf(ops.run(ops.ticketUpdate, actorOf('owner'), { ticketId: imported.id, authorId: people.stranger }))).toBe(422)
    })

    it('ignores a field the ticket’s own schema does not have', async () => {
      // A manual ticket has no `authorId`, and zod strips what it does not know rather than
      // rejecting it — the same answer the route gave before the operation existed.
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Manual', laneId }) as { ticket: { id: string; author: { id: string } } }
      expect(ticket.author.id).toBe(people.editor)
      const updated = await ops.run(ops.ticketUpdate, actorOf('editor'), { ticketId: ticket.id, authorId: people.stranger }) as { ticket: { author: { id: string } } }
      // Stripped, not honoured: the author it was filed under is still the author.
      expect(updated.ticket.author.id).toBe(people.editor)
    })

    it('will not delete the last board', async () => {
      for (const board of db.listBoards().slice(1)) await ops.run(ops.boardDelete, actorOf('owner'), { boardId: board.id })
      expect(db.listBoards()).toHaveLength(1)
      expect(await statusOf(ops.run(ops.boardDelete, actorOf('owner'), { boardId: db.listBoards()[0]!.id }))).toBe(409)
    })

    it('runs a comment through the thread and the history', async () => {
      const { ticket } = await ops.run(ops.ticketCreate, actorOf('editor'), { boardId, title: 'Discussed', laneId }) as { ticket: { id: string } }
      const { comment } = await ops.run(ops.commentAdd, agentOf('editor'), { ticketId: ticket.id, body: 'Said by an agent' }) as { comment: { id: string } }

      const { comments } = await ops.run(ops.commentList, actorOf('viewer'), { ticketId: ticket.id }) as { comments: Array<{ id: string }> }
      expect(comments.map(entry => entry.id)).toContain(comment.id)

      const commented = db.listActivity(ticket.id).find(entry => entry.kind === 'commented')!
      expect(commented).toMatchObject({ agentId: 'claude-desktop', channel: 'mcp' })
      expect(commented.actor?.id).toBe(people.editor)

      // Somebody else's comment is not theirs to edit.
      expect(await statusOf(ops.run(ops.commentUpdate, actorOf('viewer'), { commentId: comment.id, body: 'Not mine' }))).toBe(403)
      expect(await statusOf(ops.run(ops.commentUpdate, actorOf('editor'), { commentId: comment.id, body: 'Mine' }))).toBe(200)
    })
  })
})
