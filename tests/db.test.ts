import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

describe('ticket persistence', () => {
  let db: typeof import('../server/utils/db')
  let boardId = ''
  let laneIdByName: Record<string, string> = {}

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-db-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    db = await import('../server/utils/db')
    const board = db.listBoards()[0]!
    boardId = board.id
    laneIdByName = Object.fromEntries(board.lanes.map(lane => [lane.name, lane.id]))
  })

  it('seeds a default board with the canonical import lane', () => {
    const boards = db.listBoards()
    expect(boards).toHaveLength(1)
    expect(boards[0]!.name).toBe('Workboard')
    expect(boards[0]!.lanes.map(lane => lane.name)).toEqual(['Import', 'Backlog', 'Open', 'Question', 'In Progress', 'Done'])
    expect(boards[0]!.lanes.filter(lane => lane.isImport).map(lane => lane.name)).toEqual(['Import'])
    expect(db.importLaneFor(boardId)?.name).toBe('Import')
    expect(db.defaultLaneFor(boardId)?.name).toBe('Backlog')
  })

  it('creates, moves, archives and restores a ticket', () => {
    const ticket = db.createTicket(
      boardId,
      { title: 'Persistent ticket', priority: 'high', buildNumber: '42', labels: ['API'] },
      { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', userId: null, status: null }
    )!
    expect(ticket.ticketNumber).toBe(1)
    expect(ticket.boardId).toBe(boardId)
    expect(ticket.laneId).toBe(laneIdByName.Backlog)
    expect(ticket.buildNumber).toBe('42')
    expect(ticket.author).toEqual({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', userId: null, status: null })
    expect(ticket.labels.map(label => label.name)).toEqual(['API'])

    expect(db.updateTicket(ticket.id, { buildNumber: '43' })).toMatchObject({ buildNumber: '43' })

    expect(db.moveTicket(ticket.id, laneIdByName['In Progress']!, 0)?.laneId).toBe(laneIdByName['In Progress'])
    expect(db.archiveTicket(ticket.id)?.archivedAt).toBeTruthy()
    expect(db.listTickets(boardId)).toHaveLength(0)
    expect(db.listTickets(boardId, true)).toHaveLength(1)
    // Restoring returns the ticket to the lane it was archived from, not to a fixed default.
    expect(db.restoreTicket(ticket.id)?.laneId).toBe(laneIdByName['In Progress'])
    db.archiveTicket(ticket.id)
  })

  it('refuses to move a ticket into a lane of another board', () => {
    const other = db.createBoard('Other app')
    const ticket = db.createTicket(boardId, { title: 'Stays put' })!
    expect(db.moveTicket(ticket.id, other.lanes[1]!.id, 0)).toBeNull()
    expect(db.findTicket(ticket.id)?.laneId).toBe(laneIdByName.Backlog)
    db.archiveTicket(ticket.id)
    db.deleteBoard(other.id)
  })

  it('deduplicates imported feedback by external id within a board', () => {
    const importLane = db.importLaneFor(boardId)!.id
    const crash = db.insertImportedTicket({
      boardId,
      laneId: importLane,
      externalId: 'apple-feedback-1',
      type: 'crash',
      title: 'Crash on launch',
      comment: null,
      testerEmail: null,
      deviceModel: 'iPhone',
      osVersion: '18.0',
      locale: 'en-US',
      buildId: 'build-1',
      buildVersion: '42',
      buildBundleId: 'com.example.app',
      sourceCreatedAt: '2026-08-20T12:00:00.000Z',
      raw: {}
    })
    const screenshot = db.insertImportedTicket({
      boardId, laneId: importLane, externalId: 'apple-feedback-2', type: 'screenshot', title: 'Display issue',
      comment: 'Wrong color', testerEmail: null, deviceModel: 'iPhone', osVersion: '18.0', locale: 'en-US',
      buildId: 'build-1', buildVersion: '42', buildBundleId: 'com.example.app', sourceCreatedAt: '2026-08-20T13:00:00.000Z', raw: {}
    })
    expect(crash.laneId).toBe(importLane)
    expect(crash.position).toBe(0)
    expect(screenshot.laneId).toBe(importLane)
    expect(screenshot.position).toBe(1)
    expect(screenshot.description).toBe('')
    expect(screenshot.feedback?.comment).toBe('Wrong color')
    expect(screenshot.buildNumber).toBe('42')
    const updatedScreenshot = db.updateTicket(screenshot.id, {
      title: 'Revised title', description: 'Old duplicate description',
      priority: 'urgent', dueDate: '2026-08-30', labels: ['Regression'], categoryName: 'iOS',
      todos: [{ text: 'Check regression', completed: false }]
    })
    expect(updatedScreenshot).toMatchObject({
      title: 'Revised title', description: 'Old duplicate description',
      priority: 'urgent', dueDate: '2026-08-30', category: { name: 'iOS' }
    })
    expect(updatedScreenshot?.todos.map(todo => todo.text)).toEqual(['Check regression'])
    expect(updatedScreenshot?.labels.map(label => label.name)).toEqual(['Regression'])
    expect(db.clearImportedDescriptions(db.getDb())).toBe(1)
    expect(db.findTicket(screenshot.id)?.description).toBe('')
    expect(db.hasExternalTicket(boardId, 'apple-feedback-1')).toBe(true)
    expect(() => db.insertImportedTicket({
      boardId, laneId: importLane, externalId: 'apple-feedback-1', type: 'crash', title: 'Duplicate', comment: null,
      testerEmail: null, deviceModel: null, osVersion: null, locale: null, buildId: null, buildVersion: null,
      buildBundleId: null, sourceCreatedAt: '2026-08-20T12:00:00.000Z', raw: {}
    })).toThrow()

    // The same Apple feedback may be tracked again on a board with its own credentials.
    const second = db.createBoard('Second app')
    expect(db.hasExternalTicket(second.id, 'apple-feedback-1')).toBe(false)
    expect(() => db.insertImportedTicket({
      boardId: second.id, laneId: db.importLaneFor(second.id)!.id, externalId: 'apple-feedback-1', type: 'crash',
      title: 'Same feedback, other board', comment: null, testerEmail: null, deviceModel: null, osVersion: null,
      locale: null, buildId: null, buildVersion: null, buildBundleId: null, sourceCreatedAt: '2026-08-20T12:00:00.000Z', raw: {}
    })).not.toThrow()
    db.deleteBoard(second.id)

    db.archiveTicket(crash.id)
    db.archiveTicket(screenshot.id)
  })

  it('creates, completes, sorts and deletes todos while preserving them through archiving', () => {
    const ticket = db.createTicket(boardId, {
      title: 'Ticket with to-dos',
      todos: [
        { text: 'Reproduce', completed: false },
        { text: 'Fix', completed: false },
        { text: 'Test', completed: false },
      ]
    })!
    expect(ticket.todos.map(todo => ({ text: todo.text, completed: todo.completed, position: todo.position }))).toEqual([
      { text: 'Reproduce', completed: false, position: 0 },
      { text: 'Fix', completed: false, position: 1 },
      { text: 'Test', completed: false, position: 2 },
    ])

    const updated = db.updateTicket(ticket.id, {
      todos: [
        { text: 'Test', completed: true },
        { text: 'Reproduce', completed: false },
      ]
    })
    expect(updated?.todos.map(todo => ({ text: todo.text, completed: todo.completed, position: todo.position }))).toEqual([
      { text: 'Test', completed: true, position: 0 },
      { text: 'Reproduce', completed: false, position: 1 },
    ])

    db.archiveTicket(ticket.id)
    expect(db.findTicket(ticket.id)?.todos.map(todo => todo.text)).toEqual(['Test', 'Reproduce'])
    db.restoreTicket(ticket.id)
    expect(db.findTicket(ticket.id)?.todos.map(todo => todo.text)).toEqual(['Test', 'Reproduce'])
    db.archiveTicket(ticket.id)
  })

  it('restores previously shortened imported titles from the original feedback', () => {
    const comment = 'When selecting a new channel, the radio switches to the summary too early and therefore does not show the complete sequence.'
    const ticket = db.insertImportedTicket({
      boardId, laneId: db.importLaneFor(boardId)!.id, externalId: 'apple-feedback-long-title', type: 'screenshot',
      title: `${comment.slice(0, 107)}…`, comment, testerEmail: null, deviceModel: null, osVersion: null, locale: null,
      buildId: null, buildVersion: null, buildBundleId: null, sourceCreatedAt: '2026-08-20T14:00:00.000Z', raw: {}
    })

    expect(db.restoreImportedTitles(db.getDb())).toBe(1)
    expect(db.findTicket(ticket.id)?.title).toBe(comment)
    expect(db.restoreImportedTitles(db.getDb())).toBe(0)
    db.archiveTicket(ticket.id)
  })

  it('creates a ticket in the lane it was asked for', () => {
    const target = laneIdByName['In Progress']!
    const placed = db.createTicket(boardId, { title: 'Straight to work', laneId: target })!
    expect(placed.laneId).toBe(target)

    // Without a lane, and for a lane of another board, the board's first lane wins.
    const fallback = db.createTicket(boardId, { title: 'No lane given' })!
    expect(fallback.laneId).toBe(db.defaultLaneFor(boardId)!.id)
    const other = db.createBoard('Lane thief')
    const foreign = db.createTicket(boardId, { title: 'Foreign lane', laneId: other.lanes[1]!.id })!
    expect(foreign.laneId).toBe(db.defaultLaneFor(boardId)!.id)

    db.archiveTicket(placed.id)
    db.archiveTicket(fallback.id)
    db.archiveTicket(foreign.id)
  })

  it('keeps labels per board, creates them on demand and drops the unused ones', () => {
    // Fresh boards: the shared one already carries labels from the tests above.
    const home = db.createBoard('Label home')
    const other = db.createBoard('Label board')
    const first = db.createTicket(home.id, { title: 'Labelled', labels: ['Regression', 'iOS', 'ios'] })!
    // The same name on another board is a row of its own.
    const elsewhere = db.createTicket(other.id, { title: 'Elsewhere', labels: ['Regression'] })!

    // A case-insensitive duplicate collapses instead of burning a second slot.
    expect(first.labels.map(label => label.name)).toEqual(['iOS', 'Regression'])
    expect(db.listLabels(home.id).map(label => label.name)).toEqual(['iOS', 'Regression'])
    expect(db.listLabels(other.id).map(label => ({ name: label.name, ticketCount: label.ticketCount })))
      .toEqual([{ name: 'Regression', ticketCount: 1 }])
    expect(elsewhere.labels[0]!.id).not.toBe(first.labels.find(label => label.name === 'Regression')!.id)

    // A label another ticket still carries survives; the last one to drop it deletes it.
    const second = db.createTicket(home.id, { title: 'Also regressed', labels: ['Regression'] })!
    db.updateTicket(first.id, { labels: [] })
    expect(db.listLabels(home.id).map(label => label.name)).toEqual(['Regression'])
    db.updateTicket(second.id, { labels: ['Regression'] })
    expect(db.listLabels(home.id).map(label => label.name)).toEqual(['Regression'])
    db.updateTicket(second.id, { labels: [] })
    expect(db.listLabels(home.id)).toEqual([])
    // The other board is untouched by all of this.
    expect(db.listLabels(other.id).map(label => label.name)).toEqual(['Regression'])

    // Archiving is not dropping: the label has to survive so restoring finds it.
    db.archiveTicket(elsewhere.id)
    expect(db.listLabels(other.id).map(label => label.name)).toEqual(['Regression'])
    db.restoreTicket(elsewhere.id)
    expect(db.findTicket(elsewhere.id)?.labels.map(label => label.name)).toEqual(['Regression'])
  })

  it('splits shared labels onto their boards', () => {
    const legacy = new Database(':memory:')
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE tickets (id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE, title TEXT NOT NULL);
      CREATE TABLE labels (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, color TEXT NOT NULL);
      CREATE TABLE ticket_labels (
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
        PRIMARY KEY (ticket_id, label_id)
      );
      INSERT INTO boards VALUES ('board-a', 'A'), ('board-b', 'B');
      INSERT INTO tickets VALUES ('ticket-a', 'board-a', 'On A'), ('ticket-b', 'board-b', 'On B');
      INSERT INTO labels VALUES ('shared', 'TestFlight', 'blue'), ('only-a', 'Regression', 'rose'), ('unused', 'Ghost', 'amber');
      INSERT INTO ticket_labels VALUES ('ticket-a', 'shared'), ('ticket-b', 'shared'), ('ticket-a', 'only-a');
    `)

    expect(db.ensureLabelBoard(legacy)).toBe(true)
    expect(db.ensureLabelBoard(legacy)).toBe(false)

    const rows = legacy.prepare('SELECT board_id, name FROM labels ORDER BY board_id, name').all()
    expect(rows).toEqual([
      { board_id: 'board-a', name: 'Regression' },
      { board_id: 'board-a', name: 'TestFlight' },
      { board_id: 'board-b', name: 'TestFlight' },
    ])

    // Every ticket keeps the label names it had, now pointing at its own board's row.
    const namesFor = (ticketId: string) => legacy.prepare(`
      SELECT l.name FROM labels l JOIN ticket_labels tl ON tl.label_id = l.id WHERE tl.ticket_id = ? ORDER BY l.name
    `).all(ticketId).map(row => (row as { name: string }).name)
    expect(namesFor('ticket-a')).toEqual(['Regression', 'TestFlight'])
    expect(namesFor('ticket-b')).toEqual(['TestFlight'])
    expect(legacy.pragma('foreign_key_check')).toEqual([])
    legacy.close()
  })

  it('renames and recolours a category', () => {
    const ticket = db.createTicket(boardId, { title: 'Coloured', categoryName: 'Design' })!
    const category = db.listCategories(boardId).find(item => item.name === 'Design')!
    expect(category.color).toBe('neutral')

    expect(db.updateCategory(category.id, { color: 'violet' })).toMatchObject({ name: 'Design', color: 'violet' })
    // A rename keeps the colour, and the colour reaches the ticket.
    expect(db.updateCategory(category.id, { name: '  Design system  ' })).toMatchObject({ name: 'Design system', color: 'violet' })
    expect(db.findTicket(ticket.id)?.category).toMatchObject({ name: 'Design system', color: 'violet' })

    // Names stay unique per board, case-insensitively.
    const other = db.createTicket(boardId, { title: 'Second', categoryName: 'Research' })!
    expect(() => db.updateCategory(other.category!.id, { name: 'design system' })).toThrow(db.CategoryNameTakenError)
    // Another board may reuse the name.
    const elsewhere = db.createBoard('Colour board')
    const twin = db.createTicket(elsewhere.id, { title: 'Twin', categoryName: 'Spare' })!
    expect(db.updateCategory(twin.category!.id, { name: 'Design system' })?.name).toBe('Design system')
    expect(db.updateCategory('missing-id', { color: 'rose' })).toBeNull()
  })

  it('scopes categories to their board', () => {
    const first = db.createTicket(boardId, { title: 'Frontend issue', labels: ['Regression'], categoryName: 'Frontend' })!
    const second = db.createTicket(boardId, { title: 'Another issue', categoryName: 'frontend' })!

    expect(first.category?.name).toBe('Frontend')
    expect(second.category?.id).toBe(first.category?.id)
    expect(db.listCategories(boardId).find(category => category.id === first.category?.id)?.ticketCount).toBe(2)

    // The same category name on another board is a separate row.
    const other = db.createBoard('Category board')
    const elsewhere = db.createTicket(other.id, { title: 'Other board issue', categoryName: 'Frontend' })!
    expect(elsewhere.category?.id).not.toBe(first.category?.id)
    expect(db.listCategories(other.id).map(category => category.name)).toEqual(['Frontend'])
    expect(db.listCategories(boardId).some(category => category.id === elsewhere.category?.id)).toBe(false)

    const reassigned = db.updateTicket(first.id, { categoryName: 'Backend' })
    expect(reassigned?.category?.name).toBe('Backend')
    expect(reassigned?.labels.map(label => label.name)).toEqual(['Regression'])

    db.archiveTicket(second.id)
    expect(db.deleteCategory(second.category!.id)).toBe(true)
    expect(db.findTicket(second.id)?.category).toBeNull()
    expect(db.updateTicket(first.id, { categoryName: null })?.category).toBeNull()

    // Deleting a board takes its categories and tickets with it.
    db.deleteBoard(other.id)
    expect(db.findTicket(elsewhere.id)).toBeNull()
    db.archiveTicket(first.id)
  })

  it('adds the question status without losing existing relational data', () => {
    const legacy = new Database(':memory:')
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('backlog', 'open', 'in_progress', 'done')),
        position INTEGER NOT NULL, priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        due_date TEXT, source TEXT NOT NULL CHECK (source IN ('manual', 'testflight_screenshot', 'testflight_crash')),
        external_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
      CREATE TABLE child (ticket_id TEXT REFERENCES tickets(id));
      INSERT INTO tickets VALUES ('legacy', 'Existing', '', 'open', 0, 'medium', NULL, 'manual', NULL, '2026-01-01', '2026-01-01', NULL);
      INSERT INTO child VALUES ('legacy');
    `)
    expect(db.ensureQuestionStatus(legacy)).toBe(true)
    const sql = (legacy.prepare("SELECT sql FROM sqlite_schema WHERE name = 'tickets'").get() as { sql: string }).sql
    expect(sql).toContain("'question'")
    expect(sql).toContain('category_id')
    expect(legacy.prepare('SELECT title FROM tickets WHERE id = ?').get('legacy')).toEqual({ title: 'Existing' })
    expect(legacy.pragma('foreign_key_check')).toEqual([])
    legacy.close()
  })

  it('adds the import status and migrates only active TestFlight backlog tickets', () => {
    const legacy = new Database(':memory:')
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE);
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('backlog', 'open', 'question', 'in_progress', 'done')),
        position INTEGER NOT NULL, priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        due_date TEXT, source TEXT NOT NULL CHECK (source IN ('manual', 'testflight_screenshot', 'testflight_crash')),
        external_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
        category_id TEXT REFERENCES categories(id) ON DELETE SET NULL
      );
      CREATE TABLE labels (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL);
      CREATE TABLE ticket_labels (
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
        PRIMARY KEY (ticket_id, label_id)
      );
      CREATE TABLE apple_feedback (
        ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
        feedback_type TEXT NOT NULL, source_created_at TEXT NOT NULL
      );
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL UNIQUE
      );
      INSERT INTO categories VALUES ('category', 'iOS');
      INSERT INTO labels VALUES ('label', 'TestFlight', 'blue');
      INSERT INTO tickets VALUES
        ('manual', 'Manual', '', 'backlog', 0, 'medium', NULL, 'manual', NULL, '2026-01-01', '2026-01-01', NULL, NULL),
        ('screenshot', 'Screenshot', '', 'backlog', 1, 'medium', NULL, 'testflight_screenshot', 'external-1', '2026-01-02', '2026-01-02', NULL, 'category'),
        ('crash', 'Crash', '', 'backlog', 2, 'high', NULL, 'testflight_crash', 'external-2', '2026-01-03', '2026-01-03', NULL, NULL),
        ('archived', 'Archived', '', 'backlog', 3, 'medium', NULL, 'testflight_screenshot', 'external-3', '2026-01-04', '2026-01-04', '2026-02-01', NULL),
        ('started', 'Started', '', 'in_progress', 0, 'high', NULL, 'testflight_crash', 'external-4', '2026-01-05', '2026-01-05', NULL, NULL),
        ('done', 'Done', '', 'done', 0, 'medium', NULL, 'testflight_screenshot', 'external-5', '2026-01-06', '2026-01-06', NULL, NULL);
      INSERT INTO ticket_labels VALUES ('screenshot', 'label');
      INSERT INTO apple_feedback VALUES ('screenshot', 'screenshot', '2026-01-02');
      INSERT INTO attachments VALUES ('attachment', 'screenshot', 'screenshot/image.png');
    `)

    expect(db.ensureImportStatus(legacy)).toBe(true)
    expect(db.ensureImportStatus(legacy)).toBe(false)
    const rows = legacy.prepare('SELECT id, status, position FROM tickets ORDER BY id').all() as Array<{ id: string; status: string; position: number }>
    const tickets = Object.fromEntries(rows.map(ticket => [ticket.id, ticket]))
    expect(tickets.screenshot).toMatchObject({ status: 'import', position: 0 })
    expect(tickets.crash).toMatchObject({ status: 'import', position: 1 })
    expect(tickets.manual).toMatchObject({ status: 'backlog', position: 0 })
    expect(tickets.archived?.status).toBe('backlog')
    expect(tickets.started?.status).toBe('in_progress')
    expect(tickets.done?.status).toBe('done')
    expect(legacy.prepare('SELECT category_id FROM tickets WHERE id = ?').get('screenshot')).toEqual({ category_id: 'category' })
    expect(legacy.prepare('SELECT * FROM ticket_labels').all()).toEqual([{ ticket_id: 'screenshot', label_id: 'label' }])
    expect(legacy.prepare('SELECT ticket_id FROM apple_feedback').all()).toEqual([{ ticket_id: 'screenshot' }])
    expect(legacy.prepare('SELECT ticket_id FROM attachments').all()).toEqual([{ ticket_id: 'screenshot' }])
    expect(legacy.pragma('foreign_key_check')).toEqual([])
    legacy.close()
  })

  it('adds ticket comments and manual attachment kinds without losing data', () => {
    const legacy = new Database(':memory:')
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE tickets (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('screenshot', 'crashlog')),
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        relative_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      INSERT INTO tickets VALUES ('ticket', 'Existing');
      INSERT INTO attachments VALUES ('attachment', 'ticket', 'screenshot', 'image.png', 'image/png', 42, 'ticket/image.png', '2026-08-25');
    `)

    expect(db.ensureTicketComment(legacy)).toBe(true)
    expect(db.ensureTicketComment(legacy)).toBe(false)
    expect(db.ensureManualAttachmentKind(legacy)).toBe(true)
    expect(db.ensureManualAttachmentKind(legacy)).toBe(false)
    expect(legacy.prepare('SELECT comment FROM tickets').get()).toEqual({ comment: '' })
    expect(legacy.prepare('SELECT kind, filename FROM attachments').get()).toEqual({ kind: 'screenshot', filename: 'image.png' })
    expect(() => legacy.prepare("INSERT INTO attachments VALUES ('manual', 'ticket', 'file', 'note.txt', 'text/plain', 1, 'ticket/note.txt', '2026-08-25')").run()).not.toThrow()
    expect(legacy.pragma('foreign_key_check')).toEqual([])
    legacy.close()
  })

  it('assigns stable sequential numbers to existing tickets', () => {
    const legacy = new Database(':memory:')
    legacy.exec(`
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      INSERT INTO tickets VALUES
        ('later', '2026-01-02'),
        ('first-b', '2026-01-01'),
        ('first-a', '2026-01-01');
    `)

    expect(db.ensureTicketNumber(legacy)).toBe(true)
    expect(db.ensureTicketNumber(legacy)).toBe(false)
    expect(legacy.prepare('SELECT id, ticket_number FROM tickets ORDER BY ticket_number').all()).toEqual([
      { id: 'first-a', ticket_number: 1 },
      { id: 'first-b', ticket_number: 2 },
      { id: 'later', ticket_number: 3 },
    ])
    expect(() => legacy.prepare("UPDATE tickets SET ticket_number = 1 WHERE id = 'later'").run()).toThrow()
    legacy.close()
  })

  it('adds and backfills immutable author snapshots for manual tickets', () => {
    const legacy = new Database(':memory:')
    legacy.exec(`
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL
      );
      INSERT INTO tickets VALUES
        ('manual', 'manual'),
        ('imported', 'testflight_screenshot');
    `)
    const author = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' }

    expect(db.ensureTicketAuthor(legacy, author)).toBe(true)
    expect(db.ensureTicketAuthor(legacy, { firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.com' })).toBe(false)
    expect(legacy.prepare('SELECT author_first_name, author_last_name, author_email FROM tickets WHERE id = ?').get('manual')).toEqual({
      author_first_name: 'Ada',
      author_last_name: 'Lovelace',
      author_email: 'ada@example.com',
    })
    expect(legacy.prepare('SELECT author_first_name, author_last_name, author_email FROM tickets WHERE id = ?').get('imported')).toEqual({
      author_first_name: null,
      author_last_name: null,
      author_email: null,
    })
    legacy.close()
  })

  it('adds optional build numbers to existing tickets', () => {
    const legacy = new Database(':memory:')
    legacy.exec('CREATE TABLE tickets (id TEXT PRIMARY KEY); INSERT INTO tickets VALUES (\'ticket\');')

    expect(db.ensureTicketBuildNumber(legacy)).toBe(true)
    expect(db.ensureTicketBuildNumber(legacy)).toBe(false)
    expect(legacy.prepare('SELECT build_number FROM tickets').get()).toEqual({ build_number: null })
    legacy.close()
  })

  it('adds the todo table idempotently and cascades ticket deletion', () => {
    const legacy = new Database(':memory:')
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE tickets (id TEXT PRIMARY KEY);
      INSERT INTO tickets VALUES ('ticket');
    `)

    expect(db.ensureTicketTodos(legacy)).toBe(true)
    expect(db.ensureTicketTodos(legacy)).toBe(false)
    legacy.prepare("INSERT INTO ticket_todos VALUES ('todo', 'ticket', 'Existing', 0, 0)").run()
    legacy.prepare("DELETE FROM tickets WHERE id = 'ticket'").run()
    expect(legacy.prepare('SELECT * FROM ticket_todos').all()).toEqual([])
    expect(legacy.pragma('foreign_key_check')).toEqual([])
    legacy.close()
  })

  it('migrates a status-based board onto boards and lanes', () => {
    const legacy = new Database(':memory:')
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE);
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY, ticket_number INTEGER NOT NULL UNIQUE, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('import', 'backlog', 'open', 'question', 'in_progress', 'done')),
        position INTEGER NOT NULL, priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        due_date TEXT, build_number TEXT,
        source TEXT NOT NULL CHECK (source IN ('manual', 'testflight_screenshot', 'testflight_crash')),
        external_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
        author_first_name TEXT, author_last_name TEXT, author_email TEXT,
        category_id TEXT REFERENCES categories(id) ON DELETE SET NULL
      );
      CREATE TABLE sync_runs (
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
        imported_count INTEGER NOT NULL DEFAULT 0, skipped_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0, error_message TEXT
      );
      INSERT INTO categories VALUES ('category', 'iOS');
      INSERT INTO tickets (id, ticket_number, title, status, position, priority, source, external_id, created_at, updated_at, category_id) VALUES
        ('imported', 1, 'Imported', 'import', 0, 'high', 'testflight_crash', 'external-1', '2026-01-01', '2026-01-01', 'category'),
        ('waiting', 2, 'Waiting', 'question', 0, 'medium', 'manual', NULL, '2026-01-02', '2026-01-02', NULL),
        ('shipped', 3, 'Shipped', 'done', 0, 'low', 'manual', NULL, '2026-01-03', '2026-01-03', NULL);
      INSERT INTO sync_runs VALUES ('run', '2026-01-01', '2026-01-01', 'success', 1, 0, 0, NULL);
    `)

    expect(db.ensureBoards(legacy)).toBe(true)
    expect(db.ensureBoards(legacy)).toBe(false)

    const board = legacy.prepare('SELECT id, name FROM boards').get() as { id: string; name: string }
    expect(board.name).toBe('Workboard')
    const lanes = legacy.prepare('SELECT id, name, position, is_import FROM lanes ORDER BY position').all() as Array<{ id: string; name: string; position: number; is_import: number }>
    expect(lanes.map(lane => lane.name)).toEqual(['Import', 'Backlog', 'Open', 'Question', 'In Progress', 'Done'])
    expect(lanes.filter(lane => lane.is_import).map(lane => lane.name)).toEqual(['Import'])

    const laneById = Object.fromEntries(lanes.map(lane => [lane.id, lane.name]))
    const tickets = legacy.prepare('SELECT id, board_id, lane_id, ticket_number, category_id FROM tickets ORDER BY id').all() as Array<{ id: string; board_id: string; lane_id: string; ticket_number: number; category_id: string | null }>
    expect(tickets.map(ticket => [ticket.id, laneById[ticket.lane_id]])).toEqual([
      ['imported', 'Import'],
      ['shipped', 'Done'],
      ['waiting', 'Question'],
    ])
    expect(tickets.every(ticket => ticket.board_id === board.id)).toBe(true)
    expect(tickets.map(ticket => ticket.ticket_number).sort()).toEqual([1, 2, 3])
    expect(tickets.find(ticket => ticket.id === 'imported')?.category_id).toBe('category')

    expect(legacy.prepare('SELECT board_id FROM categories').get()).toEqual({ board_id: board.id })
    expect(legacy.prepare('SELECT board_id FROM sync_runs').get()).toEqual({ board_id: board.id })
    expect(legacy.prepare("SELECT sql FROM sqlite_schema WHERE name = 'tickets'").get()).not.toMatchObject({ sql: expect.stringContaining("CHECK (status") })
    expect(legacy.pragma('foreign_key_check')).toEqual([])
    legacy.close()
  })

  it('adds the submission limit to boards created before it existed', () => {
    const legacy = new Database(':memory:')
    legacy.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO boards VALUES ('board', 'Workboard', 0, '2026-01-01');
    `)

    expect(db.ensureBoardSyncLimit(legacy)).toBe(true)
    expect(db.ensureBoardSyncLimit(legacy)).toBe(false)
    expect(legacy.prepare('SELECT sync_limit FROM boards').get()).toEqual({ sync_limit: db.DEFAULT_SYNC_LIMIT })
    legacy.close()
  })

  it('leaves the legacy status migrations inert once a database is on lanes', () => {
    const migrated = new Database(':memory:')
    migrated.exec(`
      CREATE TABLE tickets (id TEXT PRIMARY KEY, lane_id TEXT NOT NULL, title TEXT NOT NULL);
      INSERT INTO tickets VALUES ('ticket', 'lane', 'Untouched');
    `)
    expect(db.ensureQuestionStatus(migrated)).toBe(false)
    expect(db.ensureImportStatus(migrated)).toBe(false)
    expect(db.ensureTicketComment(migrated)).toBe(false)
    expect(db.ensureTicketCategory(migrated)).toBe(false)
    expect(migrated.prepare('SELECT title FROM tickets').get()).toEqual({ title: 'Untouched' })
    migrated.close()
  })
})
