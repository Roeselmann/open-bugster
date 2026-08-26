import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppleFeedback, Attachment, Category, CategorySummary, Label, SyncRun, Ticket, TicketAuthor, TicketPriority, TicketSource, TicketStatus, TicketTodo, TicketTodoInput } from '../../shared/types/domain'

let database: Database.Database | null = null

const schema = `
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  ticket_number INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('import', 'backlog', 'open', 'question', 'in_progress', 'done')),
  position INTEGER NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  due_date TEXT,
  build_number TEXT,
  source TEXT NOT NULL CHECK (source IN ('manual', 'testflight_screenshot', 'testflight_crash')),
  external_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  author_first_name TEXT,
  author_last_name TEXT,
  author_email TEXT,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  color TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_labels (
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, label_id)
);
CREATE TABLE IF NOT EXISTS ticket_todos (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  position INTEGER NOT NULL,
  UNIQUE (ticket_id, position)
);
CREATE TABLE IF NOT EXISTS apple_feedback (
  ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  feedback_type TEXT NOT NULL CHECK (feedback_type IN ('screenshot', 'crash')),
  comment TEXT,
  tester_email TEXT,
  device_model TEXT,
  os_version TEXT,
  locale TEXT,
  build_id TEXT,
  build_version TEXT,
  build_bundle_id TEXT,
  source_created_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('screenshot', 'crashlog', 'file')),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  imported_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_board ON tickets(archived_at, status, position);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON apple_feedback(source_created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON attachments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_todos_ticket ON ticket_todos(ticket_id, position);
CREATE INDEX IF NOT EXISTS idx_sync_runs_status_started ON sync_runs(status, started_at DESC);
`

export function getDb() {
  if (database) return database
  const path = process.env.DATABASE_PATH || './data/open-bugster.sqlite'
  mkdirSync(dirname(path), { recursive: true })
  database = new Database(path)
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')
  database.exec(schema)
  ensureQuestionStatus(database)
  ensureTicketCategory(database)
  ensureImportStatus(database)
  ensureTicketComment(database)
  ensureTicketNumber(database)
  ensureTicketAuthor(database, configuredAdminAuthor())
  ensureTicketBuildNumber(database)
  ensureManualAttachmentKind(database)
  ensureTicketTodos(database)
  clearImportedDescriptions(database)
  restoreImportedTitles(database)
  database.pragma('optimize')
  return database
}

function configuredAdminAuthor(): TicketAuthor | null {
  const firstName = process.env.APP_ADMIN_FIRST_NAME?.trim() || ''
  const lastName = process.env.APP_ADMIN_LAST_NAME?.trim() || ''
  const email = process.env.APP_ADMIN_EMAIL?.trim() || ''
  return firstName && lastName && email ? { firstName, lastName, email } : null
}

export function ensureQuestionStatus(db: Database.Database) {
  const table = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tickets'").get() as { sql: string } | undefined
  if (!table || table.sql.includes("'question'")) return false

  db.exec('CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE)')
  const hasCategory = (db.pragma('table_info(tickets)') as Array<{ name: string }>).some(column => column.name === 'category_id')
  const hasComment = (db.pragma('table_info(tickets)') as Array<{ name: string }>).some(column => column.name === 'comment')
  db.pragma('foreign_keys = OFF')
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE tickets_migration (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        comment TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('backlog', 'open', 'question', 'in_progress', 'done')),
        position INTEGER NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        due_date TEXT,
        source TEXT NOT NULL CHECK (source IN ('manual', 'testflight_screenshot', 'testflight_crash')),
        external_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        category_id TEXT REFERENCES categories(id) ON DELETE SET NULL
      );
      INSERT INTO tickets_migration (id, title, description, comment, status, position, priority, due_date, source, external_id, created_at, updated_at, archived_at, category_id)
      SELECT id, title, description, ${hasComment ? 'comment' : "''"}, status, position, priority, due_date, source, external_id, created_at, updated_at, archived_at, ${hasCategory ? 'category_id' : 'NULL'} FROM tickets;
      DROP TABLE tickets;
      ALTER TABLE tickets_migration RENAME TO tickets;
      COMMIT;
    `)
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw error
  } finally {
    db.pragma('foreign_keys = ON')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_board ON tickets(archived_at, status, position)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category_id)')
  const foreignKeyErrors = db.pragma('foreign_key_check') as unknown[]
  if (foreignKeyErrors.length) throw new Error('The SQLite migration created invalid foreign keys.')
  return true
}

export function ensureTicketCategory(db: Database.Database) {
  db.exec('CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE)')
  const hasCategory = (db.pragma('table_info(tickets)') as Array<{ name: string }>).some(column => column.name === 'category_id')
  if (!hasCategory) db.exec('ALTER TABLE tickets ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category_id)')
  return !hasCategory
}

export function ensureImportStatus(db: Database.Database) {
  const table = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tickets'").get() as { sql: string } | undefined
  if (!table || table.sql.includes("'import'")) return false

  const hasCategory = (db.pragma('table_info(tickets)') as Array<{ name: string }>).some(column => column.name === 'category_id')
  const hasComment = (db.pragma('table_info(tickets)') as Array<{ name: string }>).some(column => column.name === 'comment')
  db.pragma('foreign_keys = OFF')
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE tickets_migration (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        comment TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('import', 'backlog', 'open', 'question', 'in_progress', 'done')),
        position INTEGER NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        due_date TEXT,
        source TEXT NOT NULL CHECK (source IN ('manual', 'testflight_screenshot', 'testflight_crash')),
        external_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        category_id TEXT REFERENCES categories(id) ON DELETE SET NULL
      );
      INSERT INTO tickets_migration (id, title, description, comment, status, position, priority, due_date, source, external_id, created_at, updated_at, archived_at, category_id)
      SELECT id, title, description, ${hasComment ? 'comment' : "''"},
        CASE
          WHEN status = 'backlog' AND archived_at IS NULL AND source IN ('testflight_screenshot', 'testflight_crash') THEN 'import'
          ELSE status
        END,
        position, priority, due_date, source, external_id, created_at, updated_at, archived_at, ${hasCategory ? 'category_id' : 'NULL'}
      FROM tickets;
      DROP TABLE tickets;
      ALTER TABLE tickets_migration RENAME TO tickets;
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY status ORDER BY position, created_at, id) - 1 AS next_position
        FROM tickets
        WHERE archived_at IS NULL AND status IN ('import', 'backlog')
      )
      UPDATE tickets
      SET position = (SELECT next_position FROM ranked WHERE ranked.id = tickets.id)
      WHERE id IN (SELECT id FROM ranked);
      COMMIT;
    `)
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw error
  } finally {
    db.pragma('foreign_keys = ON')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_board ON tickets(archived_at, status, position)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category_id)')
  const foreignKeyErrors = db.pragma('foreign_key_check') as unknown[]
  if (foreignKeyErrors.length) throw new Error('The SQLite migration created invalid foreign keys.')
  return true
}

export function ensureTicketComment(db: Database.Database) {
  const hasComment = (db.pragma('table_info(tickets)') as Array<{ name: string }>).some(column => column.name === 'comment')
  if (!hasComment) db.exec("ALTER TABLE tickets ADD COLUMN comment TEXT NOT NULL DEFAULT ''")
  return !hasComment
}

export function ensureTicketTodos(db: Database.Database) {
  const existed = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'ticket_todos'").get())
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_todos (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
      position INTEGER NOT NULL,
      UNIQUE (ticket_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_todos_ticket ON ticket_todos(ticket_id, position);
  `)
  return !existed
}

export function ensureTicketNumber(db: Database.Database) {
  const hasTicketNumber = (db.pragma('table_info(tickets)') as Array<{ name: string }>).some(column => column.name === 'ticket_number')
  if (!hasTicketNumber) db.exec('ALTER TABLE tickets ADD COLUMN ticket_number INTEGER')

  const missing = db.prepare(`
    SELECT id
    FROM tickets
    WHERE ticket_number IS NULL
    ORDER BY created_at, id
  `).all() as Array<{ id: string }>

  if (missing.length) {
    const highest = (db.prepare('SELECT COALESCE(MAX(ticket_number), 0) AS value FROM tickets').get() as { value: number }).value
    const assign = db.prepare('UPDATE tickets SET ticket_number = ? WHERE id = ?')
    db.transaction(() => missing.forEach((ticket, index) => assign.run(highest + index + 1, ticket.id)))()
  }

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_ticket_number ON tickets(ticket_number)')
  return !hasTicketNumber
}

export function ensureTicketAuthor(db: Database.Database, author: TicketAuthor | null = null) {
  const columns = new Set((db.pragma('table_info(tickets)') as Array<{ name: string }>).map(column => column.name))
  const authorColumns: Array<[string, string]> = [
    ['author_first_name', 'TEXT'],
    ['author_last_name', 'TEXT'],
    ['author_email', 'TEXT'],
  ]
  const missingColumns = authorColumns.filter(([name]) => !columns.has(name))

  for (const [name, type] of missingColumns) db.exec(`ALTER TABLE tickets ADD COLUMN ${name} ${type}`)

  if (author && columns.has('source')) {
    db.prepare(`
      UPDATE tickets
      SET author_first_name = COALESCE(author_first_name, ?),
          author_last_name = COALESCE(author_last_name, ?),
          author_email = COALESCE(author_email, ?)
      WHERE source = 'manual'
        AND (author_first_name IS NULL OR author_last_name IS NULL OR author_email IS NULL)
    `).run(author.firstName, author.lastName, author.email)
  }

  return missingColumns.length > 0
}

export function ensureTicketBuildNumber(db: Database.Database) {
  const hasBuildNumber = (db.pragma('table_info(tickets)') as Array<{ name: string }>).some(column => column.name === 'build_number')
  if (!hasBuildNumber) db.exec('ALTER TABLE tickets ADD COLUMN build_number TEXT')
  return !hasBuildNumber
}

export function ensureManualAttachmentKind(db: Database.Database) {
  const table = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'attachments'").get() as { sql: string } | undefined
  if (!table || table.sql.includes("'file'")) return false
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE attachments_migration (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('screenshot', 'crashlog', 'file')),
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    INSERT INTO attachments_migration SELECT * FROM attachments;
    DROP TABLE attachments;
    ALTER TABLE attachments_migration RENAME TO attachments;
    COMMIT;
    CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON attachments(ticket_id);
  `)
  return true
}

export function clearImportedDescriptions(db: Database.Database) {
  return db.prepare("UPDATE tickets SET description = '' WHERE source IN ('testflight_screenshot', 'testflight_crash') AND description <> ''").run().changes
}

export function restoreImportedTitles(db: Database.Database) {
  const rows = db.prepare(`
    SELECT t.id, t.title, af.comment
    FROM tickets t
    JOIN apple_feedback af ON af.ticket_id = t.id
    WHERE t.source IN ('testflight_screenshot', 'testflight_crash')
  `).all() as Array<{ id: string; title: string; comment: string | null }>
  const update = db.prepare('UPDATE tickets SET title = ? WHERE id = ?')
  let changes = 0
  db.transaction(() => {
    for (const row of rows) {
      const title = row.comment?.replace(/\s+/g, ' ').trim()
      const shortenedTitle = title && title.length > 110 ? `${title.slice(0, 107)}…` : null
      if (shortenedTitle === row.title) changes += update.run(title, row.id).changes
    }
  })()
  return changes
}

type TicketRow = {
  id: string; ticket_number: number; title: string; description: string; comment: string; status: TicketStatus; position: number
  priority: TicketPriority; due_date: string | null; build_number: string | null; source: TicketSource; external_id: string | null
  created_at: string; updated_at: string; archived_at: string | null; category_id: string | null
  author_first_name: string | null; author_last_name: string | null; author_email: string | null
}

function hydrateTicket(row: TicketRow): Ticket {
  const db = getDb()
  const category = row.category_id
    ? db.prepare('SELECT id, name FROM categories WHERE id = ?').get(row.category_id) as Category | undefined
    : undefined
  const labels = db.prepare(`SELECT l.id, l.name, l.color FROM labels l JOIN ticket_labels tl ON tl.label_id = l.id WHERE tl.ticket_id = ? ORDER BY l.name`).all(row.id) as Label[]
  const feedbackRow = db.prepare('SELECT * FROM apple_feedback WHERE ticket_id = ?').get(row.id) as Record<string, string | null> | undefined
  const attachmentRows = db.prepare('SELECT id, kind, filename, mime_type, size FROM attachments WHERE ticket_id = ? ORDER BY created_at').all(row.id) as Array<{ id: string; kind: Attachment['kind']; filename: string; mime_type: string; size: number }>
  const todoRows = db.prepare('SELECT id, text, completed, position FROM ticket_todos WHERE ticket_id = ? ORDER BY position').all(row.id) as Array<{ id: string; text: string; completed: number; position: number }>
  const feedback: AppleFeedback | null = feedbackRow ? {
    feedbackType: feedbackRow.feedback_type as 'screenshot' | 'crash',
    comment: feedbackRow.comment ?? null,
    testerEmail: feedbackRow.tester_email ?? null,
    deviceModel: feedbackRow.device_model ?? null,
    osVersion: feedbackRow.os_version ?? null,
    locale: feedbackRow.locale ?? null,
    buildId: feedbackRow.build_id ?? null,
    buildVersion: feedbackRow.build_version ?? null,
    buildBundleId: feedbackRow.build_bundle_id ?? null,
    sourceCreatedAt: feedbackRow.source_created_at as string
  } : null
  const attachments: Attachment[] = attachmentRows.map(item => ({
    id: item.id,
    kind: item.kind,
    filename: item.filename,
    mimeType: item.mime_type,
    size: item.size,
    url: `/api/attachments/${item.id}`
  }))
  const author: TicketAuthor | null = row.author_first_name && row.author_last_name && row.author_email
    ? { firstName: row.author_first_name, lastName: row.author_last_name, email: row.author_email }
    : null
  const todos: TicketTodo[] = todoRows.map(todo => ({
    id: todo.id,
    text: todo.text,
    completed: Boolean(todo.completed),
    position: todo.position
  }))
  return {
    id: row.id,
    ticketNumber: row.ticket_number,
    title: row.title,
    description: row.description,
    comment: row.comment,
    status: row.status,
    position: row.position,
    priority: row.priority,
    dueDate: row.due_date,
    buildNumber: row.build_number || feedback?.buildVersion || null,
    source: row.source,
    externalId: row.external_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    author,
    category: category || null,
    labels,
    feedback,
    attachments,
    todos
  }
}

export function listTickets(archived = false): Ticket[] {
  const rows = getDb().prepare(`SELECT * FROM tickets WHERE archived_at IS ${archived ? 'NOT ' : ''}NULL ORDER BY status, position, created_at`).all() as TicketRow[]
  return rows.map(hydrateTicket)
}

export function findTicket(id: string): Ticket | null {
  const row = getDb().prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined
  return row ? hydrateTicket(row) : null
}

export function listCategories(): CategorySummary[] {
  return getDb().prepare(`
    SELECT c.id, c.name, COUNT(t.id) AS ticketCount
    FROM categories c
    LEFT JOIN tickets t ON t.category_id = c.id
    GROUP BY c.id, c.name
    ORDER BY c.name COLLATE NOCASE
  `).all() as CategorySummary[]
}

export function deleteCategory(id: string) {
  return getDb().prepare('DELETE FROM categories WHERE id = ?').run(id).changes > 0
}

function resolveCategoryId(name: string | null | undefined): string | null {
  const cleanName = name?.trim()
  if (!cleanName) return null
  const db = getDb()
  const existing = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').get(cleanName) as { id: string } | undefined
  if (existing) return existing.id
  const id = randomUUID()
  db.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run(id, cleanName)
  return id
}

const labelColors = ['slate', 'blue', 'violet', 'rose', 'amber', 'emerald']

function setTicketLabels(ticketId: string, names: string[]) {
  const db = getDb()
  db.prepare('DELETE FROM ticket_labels WHERE ticket_id = ?').run(ticketId)
  const cleanNames = [...new Set(names.map(name => name.trim()).filter(Boolean))].slice(0, 12)
  const find = db.prepare('SELECT id FROM labels WHERE name = ? COLLATE NOCASE')
  const insertLabel = db.prepare('INSERT INTO labels (id, name, color) VALUES (?, ?, ?)')
  const attach = db.prepare('INSERT OR IGNORE INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)')
  cleanNames.forEach((name, index) => {
    let label = find.get(name) as { id: string } | undefined
    if (!label) {
      label = { id: randomUUID() }
      insertLabel.run(label.id, name, labelColors[index % labelColors.length])
    }
    attach.run(ticketId, label.id)
  })
}

function setTicketTodos(ticketId: string, todos: TicketTodoInput[]) {
  const db = getDb()
  db.prepare('DELETE FROM ticket_todos WHERE ticket_id = ?').run(ticketId)
  const insert = db.prepare('INSERT INTO ticket_todos (id, ticket_id, text, completed, position) VALUES (?, ?, ?, ?, ?)')
  todos.forEach((todo, position) => insert.run(randomUUID(), ticketId, todo.text.trim(), todo.completed ? 1 : 0, position))
}

export interface TicketInput {
  title: string
  description?: string
  comment?: string
  priority?: TicketPriority
  dueDate?: string | null
  buildNumber?: string | null
  labels?: string[]
  categoryName?: string | null
  todos?: TicketTodoInput[]
}

export function createTicket(input: TicketInput, author: TicketAuthor | null = null): Ticket {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tickets WHERE status = 'backlog' AND archived_at IS NULL").get() as { position: number }).position
  db.transaction(() => {
    const categoryId = resolveCategoryId(input.categoryName)
    db.prepare(`INSERT INTO tickets (id, ticket_number, title, description, comment, status, position, priority, due_date, build_number, source, created_at, updated_at, author_first_name, author_last_name, author_email, category_id)
      VALUES (?, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tickets), ?, ?, ?, 'backlog', ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?)`).run(
      id, input.title, input.description || '', input.comment || '', position, input.priority || 'medium', input.dueDate || null,
      input.buildNumber || null, now, now, author?.firstName || null, author?.lastName || null, author?.email || null, categoryId
    )
    setTicketLabels(id, input.labels || [])
    setTicketTodos(id, input.todos || [])
  })()
  return findTicket(id)!
}

export function updateTicket(id: string, input: Partial<TicketInput>): Ticket | null {
  const existing = findTicket(id)
  if (!existing) return null
  const now = new Date().toISOString()
  getDb().transaction(() => {
    const categoryId = input.categoryName === undefined ? existing.category?.id || null : resolveCategoryId(input.categoryName)
    getDb().prepare(`UPDATE tickets SET title = ?, description = ?, comment = ?, priority = ?, due_date = ?, build_number = ?, category_id = ?, updated_at = ? WHERE id = ?`).run(
      input.title ?? existing.title,
      input.description ?? existing.description,
      input.comment ?? existing.comment,
      input.priority ?? existing.priority,
      input.dueDate === undefined ? existing.dueDate : input.dueDate || null,
      input.buildNumber === undefined ? (existing.source === 'manual' ? existing.buildNumber : null) : input.buildNumber || null,
      categoryId,
      now,
      id
    )
    if (input.labels) setTicketLabels(id, input.labels)
    if (input.todos !== undefined) setTicketTodos(id, input.todos)
  })()
  return findTicket(id)
}

function reindexColumn(status: TicketStatus, orderedIds: string[]) {
  const update = getDb().prepare('UPDATE tickets SET status = ?, position = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL')
  const now = new Date().toISOString()
  orderedIds.forEach((id, index) => update.run(status, index, now, id))
}

export function moveTicket(id: string, targetStatus: TicketStatus, targetIndex: number): Ticket | null {
  const current = findTicket(id)
  if (!current || current.archivedAt) return null
  const db = getDb()
  db.transaction(() => {
    const sourceIds = (db.prepare('SELECT id FROM tickets WHERE status = ? AND archived_at IS NULL ORDER BY position, created_at').all(current.status) as Array<{ id: string }>).map(row => row.id).filter(ticketId => ticketId !== id)
    const targetIds = current.status === targetStatus
      ? sourceIds
      : (db.prepare('SELECT id FROM tickets WHERE status = ? AND archived_at IS NULL ORDER BY position, created_at').all(targetStatus) as Array<{ id: string }>).map(row => row.id).filter(ticketId => ticketId !== id)
    const index = Math.max(0, Math.min(targetIndex, targetIds.length))
    targetIds.splice(index, 0, id)
    if (current.status !== targetStatus) reindexColumn(current.status, sourceIds)
    reindexColumn(targetStatus, targetIds)
  })()
  return findTicket(id)
}

export function archiveTicket(id: string): Ticket | null {
  const now = new Date().toISOString()
  const result = getDb().prepare('UPDATE tickets SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL').run(now, now, id)
  return result.changes ? findTicket(id) : null
}

export function restoreTicket(id: string): Ticket | null {
  const db = getDb()
  const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tickets WHERE status = 'backlog' AND archived_at IS NULL").get() as { position: number }).position
  const now = new Date().toISOString()
  const result = db.prepare("UPDATE tickets SET archived_at = NULL, status = 'backlog', position = ?, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL").run(position, now, id)
  return result.changes ? findTicket(id) : null
}

export function latestSyncRun(successOnly = false): SyncRun | null {
  const row = getDb().prepare(`SELECT * FROM sync_runs ${successOnly ? "WHERE status IN ('success','partial')" : ''} ORDER BY started_at DESC LIMIT 1`).get() as Record<string, string | number | null> | undefined
  return row ? {
    id: row.id as string,
    startedAt: row.started_at as string,
    finishedAt: row.finished_at as string | null,
    status: row.status as SyncRun['status'],
    importedCount: row.imported_count as number,
    skippedCount: row.skipped_count as number,
    failedCount: row.failed_count as number,
    errorMessage: row.error_message as string | null
  } : null
}

export function createSyncRun(): SyncRun {
  const id = randomUUID()
  getDb().prepare("INSERT INTO sync_runs (id, started_at, status) VALUES (?, ?, 'running')").run(id, new Date().toISOString())
  return latestSyncRun()!
}

export function finishSyncRun(id: string, status: SyncRun['status'], imported: number, skipped: number, failed: number, error: string | null) {
  getDb().prepare('UPDATE sync_runs SET finished_at = ?, status = ?, imported_count = ?, skipped_count = ?, failed_count = ?, error_message = ? WHERE id = ?')
    .run(new Date().toISOString(), status, imported, skipped, failed, error, id)
  return latestSyncRun()!
}

export function hasExternalTicket(externalId: string) {
  return Boolean(getDb().prepare('SELECT 1 FROM tickets WHERE external_id = ?').get(externalId))
}

export interface ImportedTicketInput {
  externalId: string
  type: 'screenshot' | 'crash'
  title: string
  comment: string | null
  testerEmail: string | null
  deviceModel: string | null
  osVersion: string | null
  locale: string | null
  buildId: string | null
  buildVersion: string | null
  buildBundleId: string | null
  sourceCreatedAt: string
  raw: unknown
}

export function insertImportedTicket(input: ImportedTicketInput): Ticket {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  const position = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tickets WHERE status = 'import' AND archived_at IS NULL").get() as { position: number }).position
  db.transaction(() => {
    db.prepare(`INSERT INTO tickets (id, ticket_number, title, description, status, position, priority, source, external_id, created_at, updated_at)
      VALUES (?, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tickets), ?, '', 'import', ?, ?, ?, ?, ?, ?)`).run(
      id, input.title, position, input.type === 'crash' ? 'high' : 'medium',
      input.type === 'crash' ? 'testflight_crash' : 'testflight_screenshot', input.externalId, now, now
    )
    db.prepare(`INSERT INTO apple_feedback (ticket_id, feedback_type, comment, tester_email, device_model, os_version, locale, build_id, build_version, build_bundle_id, source_created_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.type, input.comment, input.testerEmail, input.deviceModel, input.osVersion, input.locale,
      input.buildId, input.buildVersion, input.buildBundleId, input.sourceCreatedAt, JSON.stringify(input.raw)
    )
    setTicketLabels(id, ['TestFlight', input.type === 'crash' ? 'Crash' : 'Screenshot'])
  })()
  return findTicket(id)!
}

export function addAttachment(ticketId: string, kind: Attachment['kind'], filename: string, mimeType: string, size: number, relativePath: string) {
  const id = randomUUID()
  getDb().prepare('INSERT INTO attachments (id, ticket_id, kind, filename, mime_type, size, relative_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, ticketId, kind, filename, mimeType, size, relativePath, new Date().toISOString())
  return id
}

export function findAttachment(id: string) {
  return getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(id) as { id: string; ticket_id: string; kind: Attachment['kind']; filename: string; mime_type: string; size: number; relative_path: string } | undefined
}

export function deleteAttachment(id: string) {
  return getDb().prepare('DELETE FROM attachments WHERE id = ?').run(id).changes > 0
}
