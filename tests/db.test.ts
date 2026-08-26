import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

describe('ticket persistence', () => {
  let db: typeof import('../server/utils/db')

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-db-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    db = await import('../server/utils/db')
  })

  it('creates, moves, archives and restores a ticket', () => {
    const ticket = db.createTicket(
      { title: 'Persistent ticket', comment: 'First note', priority: 'high', buildNumber: '42', labels: ['API'] },
      { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' }
    )
    expect(ticket.ticketNumber).toBe(1)
    expect(ticket.status).toBe('backlog')
    expect(ticket.comment).toBe('First note')
    expect(ticket.buildNumber).toBe('42')
    expect(ticket.author).toEqual({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' })
    expect(ticket.labels.map(label => label.name)).toEqual(['API'])

    expect(db.updateTicket(ticket.id, { comment: 'Updated note', buildNumber: '43' })).toMatchObject({ comment: 'Updated note', buildNumber: '43' })

    expect(db.moveTicket(ticket.id, 'in_progress', 0)?.status).toBe('in_progress')
    expect(db.archiveTicket(ticket.id)?.archivedAt).toBeTruthy()
    expect(db.listTickets()).toHaveLength(0)
    expect(db.listTickets(true)).toHaveLength(1)
    expect(db.restoreTicket(ticket.id)?.status).toBe('backlog')
  })

  it('deduplicates imported feedback by external id', () => {
    const crash = db.insertImportedTicket({
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
      externalId: 'apple-feedback-2', type: 'screenshot', title: 'Display issue', comment: 'Wrong color', testerEmail: null,
      deviceModel: 'iPhone', osVersion: '18.0', locale: 'en-US', buildId: 'build-1', buildVersion: '42',
      buildBundleId: 'com.example.app', sourceCreatedAt: '2026-08-20T13:00:00.000Z', raw: {}
    })
    expect(crash.status).toBe('import')
    expect(crash.position).toBe(0)
    expect(screenshot.status).toBe('import')
    expect(screenshot.position).toBe(1)
    expect(screenshot.description).toBe('')
    expect(screenshot.feedback?.comment).toBe('Wrong color')
    expect(screenshot.buildNumber).toBe('42')
    expect(crash.ticketNumber).toBe(2)
    expect(screenshot.ticketNumber).toBe(3)
    const updatedScreenshot = db.updateTicket(screenshot.id, {
      title: 'Revised title', description: 'Old duplicate description', comment: 'Internal note',
      priority: 'urgent', dueDate: '2026-08-30', labels: ['Regression'], categoryName: 'iOS',
      todos: [{ text: 'Check regression', completed: false }]
    })
    expect(updatedScreenshot).toMatchObject({
      title: 'Revised title', description: 'Old duplicate description', comment: 'Internal note',
      priority: 'urgent', dueDate: '2026-08-30', category: { name: 'iOS' }
    })
    expect(updatedScreenshot?.todos.map(todo => todo.text)).toEqual(['Check regression'])
    expect(updatedScreenshot?.labels.map(label => label.name)).toEqual(['Regression'])
    expect(db.clearImportedDescriptions(db.getDb())).toBe(1)
    expect(db.findTicket(screenshot.id)?.description).toBe('')
    expect(db.hasExternalTicket('apple-feedback-1')).toBe(true)
    expect(() => db.insertImportedTicket({
      externalId: 'apple-feedback-1', type: 'crash', title: 'Duplicate', comment: null, testerEmail: null,
      deviceModel: null, osVersion: null, locale: null, buildId: null, buildVersion: null,
      buildBundleId: null, sourceCreatedAt: '2026-08-20T12:00:00.000Z', raw: {}
    })).toThrow()
  })

  it('creates, completes, sorts and deletes todos while preserving them through archiving', () => {
    const ticket = db.createTicket({
      title: 'Ticket with to-dos',
      todos: [
        { text: 'Reproduce', completed: false },
        { text: 'Fix', completed: false },
        { text: 'Test', completed: false },
      ]
    })
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
  })

  it('restores previously shortened imported titles from the original feedback', () => {
    const comment = 'When selecting a new channel, the radio switches to the summary too early and therefore does not show the complete sequence.'
    const ticket = db.insertImportedTicket({
      externalId: 'apple-feedback-long-title', type: 'screenshot', title: `${comment.slice(0, 107)}…`, comment, testerEmail: null,
      deviceModel: null, osVersion: null, locale: null, buildId: null, buildVersion: null,
      buildBundleId: null, sourceCreatedAt: '2026-08-20T14:00:00.000Z', raw: {}
    })

    expect(db.restoreImportedTitles(db.getDb())).toBe(1)
    expect(db.findTicket(ticket.id)?.title).toBe(comment)
    expect(db.restoreImportedTitles(db.getDb())).toBe(0)
  })

  it('creates, reuses, reassigns and deletes optional categories', () => {
    const first = db.createTicket({ title: 'Frontend issue', labels: ['Regression'], categoryName: 'Frontend' })
    const second = db.createTicket({ title: 'Another issue', categoryName: 'frontend' })

    expect(first.category?.name).toBe('Frontend')
    expect(second.category?.id).toBe(first.category?.id)
    expect(db.listCategories().find(category => category.id === first.category?.id)?.ticketCount).toBe(2)

    const reassigned = db.updateTicket(first.id, { categoryName: 'Backend' })
    expect(reassigned?.category?.name).toBe('Backend')
    expect(reassigned?.labels.map(label => label.name)).toEqual(['Regression'])

    db.archiveTicket(second.id)
    expect(db.deleteCategory(second.category!.id)).toBe(true)
    expect(db.findTicket(second.id)?.category).toBeNull()
    expect(db.updateTicket(first.id, { categoryName: null })?.category).toBeNull()
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
})
