import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ActivityKind, AppleFeedback, Attachment, Board, BoardCredentials, BoardMember, BoardRole, BoardSummary, Category, CategoryColor,
  CategorySummary, Label, LabelSummary, Lane, LaneSummary, Person, SyncRun, Ticket, TicketActivityEntry, TicketAuthor, TicketComment,
  TicketPriority, TicketSource, TicketTodo, TicketTodoInput, UserAccount, UserRole, UserStatus
} from '../../shared/types/domain'
import { decryptSecret, encryptSecret, secretKeyAvailable } from './secret-box'
import { getServerConfig } from './config'

let database: Database.Database | null = null

/** The denormalised author columns on `tickets`, without the read-time resolution. */
export interface AuthorSnapshot {
  firstName: string
  lastName: string
  email: string
}

const schema = `
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  asc_issuer_id TEXT NOT NULL DEFAULT '',
  asc_key_id TEXT NOT NULL DEFAULT '',
  asc_app_id TEXT NOT NULL DEFAULT '',
  asc_private_key TEXT,
  asc_key_filename TEXT,
  asc_key_uploaded_at TEXT,
  sync_limit INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lanes (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  is_import INTEGER NOT NULL DEFAULT 0 CHECK (is_import IN (0, 1))
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  board_id TEXT REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT 'neutral'
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  ticket_number INTEGER NOT NULL UNIQUE,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  lane_id TEXT NOT NULL REFERENCES lanes(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  due_date TEXT,
  build_number TEXT,
  source TEXT NOT NULL CHECK (source IN ('manual', 'testflight_screenshot', 'testflight_crash')),
  external_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  author_first_name TEXT,
  author_last_name TEXT,
  author_email TEXT,
  assignee_email TEXT,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE
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
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  session_version INTEGER NOT NULL DEFAULT 1,
  invite_token_hash TEXT,
  invite_expires_at TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS board_members (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'viewer')),
  added_at TEXT NOT NULL,
  PRIMARY KEY (board_id, user_id)
);
CREATE TABLE IF NOT EXISTS ticket_comments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_email TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_activity (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_email TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  board_id TEXT REFERENCES boards(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  imported_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON apple_feedback(source_created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON attachments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_todos_ticket ON ticket_todos(ticket_id, position);
`

// Indexes over columns that only exist once `ensureBoards` has run.
const boardIndexes = `
CREATE INDEX IF NOT EXISTS idx_sync_runs_board_started ON sync_runs(board_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lanes_board_import ON lanes(board_id) WHERE is_import = 1;
CREATE INDEX IF NOT EXISTS idx_lanes_board ON lanes(board_id, position);
CREATE INDEX IF NOT EXISTS idx_tickets_board ON tickets(board_id, archived_at, lane_id, position);
CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_ticket_number ON tickets(ticket_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_external ON tickets(board_id, external_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_board_name ON categories(board_id, name COLLATE NOCASE);
`

// Kept out of `boardIndexes`, which `ensureBoards` execs before labels are board-scoped.
const labelIndexes = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_board_name ON labels(board_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_ticket_labels_label ON ticket_labels(label_id);
`

/** How many of the newest feedback submissions a sync looks at, per feedback type. */
export const DEFAULT_SYNC_LIMIT = 100

/** The lane set every board starts with. The first entry is the canonical import lane. */
const defaultLanes: Array<{ name: string; isImport: boolean }> = [
  { name: 'Import', isImport: true },
  { name: 'Backlog', isImport: false },
  { name: 'Open', isImport: false },
  { name: 'Question', isImport: false },
  { name: 'In Progress', isImport: false },
  { name: 'Done', isImport: false },
]

/** The lane a brand-new board created from the UI starts with. */
const newBoardLanes: Array<{ name: string; isImport: boolean }> = [
  { name: 'Import', isImport: true },
  { name: 'Backlog', isImport: false },
  { name: 'In Progress', isImport: false },
  { name: 'Done', isImport: false },
]

/** Maps the retired `tickets.status` enum onto the seeded default lanes. */
const legacyStatusLaneNames: Record<string, string> = {
  import: 'Import',
  backlog: 'Backlog',
  open: 'Open',
  question: 'Question',
  in_progress: 'In Progress',
  done: 'Done',
}

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
  ensureTicketBuildNumber(database)
  ensureManualAttachmentKind(database)
  ensureTicketTodos(database)
  ensureBoards(database)
  ensureLabelBoard(database)
  database.exec(labelIndexes)
  ensureLanesWithoutColor(database)
  ensureCategoryColor(database)
  ensureBoardSyncLimit(database)
  // Ahead of the comment-thread migration, which reads `tickets.author_email`.
  ensureTicketAuthor(database, configuredAdminAuthor())
  ensureUsers(database, configuredOwnerSeed())
  warnWhenNobodyCanSignIn(database)
  ensureTicketAssignee(database)
  ensureTicketCommentThread(database)
  ensureActivityLog(database)
  database.exec(boardIndexes)
  clearImportedDescriptions(database)
  restoreImportedTitles(database)
  database.pragma('optimize')
  return database
}

/** Only ever used to backfill the author snapshot on tickets that predate accounts. */
function configuredAdminAuthor(): AuthorSnapshot | null {
  const firstName = process.env.APP_ADMIN_FIRST_NAME?.trim() || ''
  const lastName = process.env.APP_ADMIN_LAST_NAME?.trim() || ''
  const email = process.env.APP_ADMIN_EMAIL?.trim() || ''
  return firstName && lastName && email ? { firstName, lastName, email } : null
}

/**
 * The bootstrap identity, read once on first start to seed the owner account. After that
 * the `users` table is the only source of truth and these variables are ignored.
 */
function configuredOwnerSeed(): OwnerSeed | null {
  const passwordHash = process.env.APP_PASSWORD_HASH?.trim() || ''
  if (!passwordHash) return null
  const username = process.env.APP_USERNAME?.trim() || 'admin'
  return {
    email: (process.env.APP_ADMIN_EMAIL?.trim() || `${username}@localhost`).toLowerCase(),
    firstName: process.env.APP_ADMIN_FIRST_NAME?.trim() || username,
    lastName: process.env.APP_ADMIN_LAST_NAME?.trim() || '',
    passwordHash,
  }
}

/**
 * A first start without APP_PASSWORD_HASH seeds no owner, and the login page then rejects
 * every attempt with the same deliberately vague message. Say so on the console rather
 * than leaving the operator to guess why their password does not work.
 */
function warnWhenNobodyCanSignIn(db: Database.Database) {
  const accounts = (db.prepare('SELECT COUNT(*) AS value FROM users').get() as { value: number }).value
  if (accounts > 0) return
  console.warn('[open-bugster] No account exists yet, so nobody can sign in: APP_PASSWORD_HASH is not set.')
  console.warn('[open-bugster] Generate one with:  npm run password:hash -- "a-long-password"')
  console.warn('[open-bugster] Put that APP_PASSWORD_HASH line and APP_ADMIN_EMAIL into .env, then restart.')
}

type UserRef = { id: string; email: string; firstName: string; lastName: string; status: UserStatus }

/**
 * Accounts by lowercased email. `hydrateTicket` runs once per row, so looking an account
 * up per ticket would add an N+1 on top of the sub-queries it already makes; every write
 * to `users` drops the cache instead.
 */
let directoryCache: Map<string, UserRef> | null = null

function userDirectory(): Map<string, UserRef> {
  if (directoryCache) return directoryCache
  const rows = getDb().prepare('SELECT id, email, first_name, last_name, status FROM users').all() as Array<{
    id: string; email: string; first_name: string; last_name: string; status: UserStatus
  }>
  directoryCache = new Map(rows.map(row => [row.email.trim().toLowerCase(), {
    id: row.id, email: row.email, firstName: row.first_name, lastName: row.last_name, status: row.status
  }]))
  return directoryCache
}

export function invalidateUserDirectory() {
  directoryCache = null
}

/**
 * Turns a stored email into a person. When an account carries that address it wins, so a
 * rename shows up everywhere at once; otherwise the row's own snapshot is used and the
 * entry starts resolving by itself as soon as somebody creates that account.
 */
export function resolvePerson(email: string | null | undefined, snapshot?: { firstName?: string | null; lastName?: string | null }): Person | null {
  const trimmed = email?.trim()
  if (!trimmed) return null
  const account = userDirectory().get(trimmed.toLowerCase())
  if (account) {
    return { email: account.email, firstName: account.firstName, lastName: account.lastName, userId: account.id, status: account.status }
  }
  return { email: trimmed, firstName: snapshot?.firstName || '', lastName: snapshot?.lastName || '', userId: null, status: null }
}

/** Quotes a value as a SQL string literal for statements that cannot be parameterised. */
function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(column => column.name))
}

/**
 * The migrations below predate boards and all inspect the retired `tickets.status`
 * column. Once `ensureBoards` has replaced it with `lane_id` they would misread the
 * schema and rebuild the table again, so every one of them stops here.
 */
function alreadyOnLanes(db: Database.Database): boolean {
  return tableColumns(db, 'tickets').has('lane_id')
}

export function ensureQuestionStatus(db: Database.Database) {
  if (alreadyOnLanes(db)) return false
  const table = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tickets'").get() as { sql: string } | undefined
  if (!table || table.sql.includes("'question'")) return false

  db.exec('CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE)')
  const hasCategory = tableColumns(db, 'tickets').has('category_id')
  const hasComment = tableColumns(db, 'tickets').has('comment')
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
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category_id)')
  const foreignKeyErrors = db.pragma('foreign_key_check') as unknown[]
  if (foreignKeyErrors.length) throw new Error('The SQLite migration created invalid foreign keys.')
  return true
}

export function ensureTicketCategory(db: Database.Database) {
  if (alreadyOnLanes(db)) return false
  db.exec('CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE)')
  const hasCategory = tableColumns(db, 'tickets').has('category_id')
  if (!hasCategory) db.exec('ALTER TABLE tickets ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category_id)')
  return !hasCategory
}

export function ensureImportStatus(db: Database.Database) {
  if (alreadyOnLanes(db)) return false
  const table = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tickets'").get() as { sql: string } | undefined
  if (!table || table.sql.includes("'import'")) return false

  const hasCategory = tableColumns(db, 'tickets').has('category_id')
  const hasComment = tableColumns(db, 'tickets').has('comment')
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
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_category ON tickets(category_id)')
  const foreignKeyErrors = db.pragma('foreign_key_check') as unknown[]
  if (foreignKeyErrors.length) throw new Error('The SQLite migration created invalid foreign keys.')
  return true
}

export function ensureTicketComment(db: Database.Database) {
  if (alreadyOnLanes(db)) return false
  const hasComment = tableColumns(db, 'tickets').has('comment')
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
  const hasTicketNumber = tableColumns(db, 'tickets').has('ticket_number')
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

export function ensureTicketAuthor(db: Database.Database, author: AuthorSnapshot | null = null) {
  const columns = tableColumns(db, 'tickets')
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
  const hasBuildNumber = tableColumns(db, 'tickets').has('build_number')
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

/** Reads the legacy .p8 once so an upgraded instance keeps syncing without a re-upload. */
function legacyPrivateKey(path: string): { pem: string; filename: string } | null {
  if (!path) return null
  try {
    const pem = readFileSync(path, 'utf8')
    if (!pem.includes('BEGIN PRIVATE KEY')) return null
    return { pem, filename: path.split('/').pop() || 'AuthKey.p8' }
  } catch {
    return null
  }
}

/**
 * Introduces boards and lanes. Everything that existed before becomes one board named
 * "Workboard" whose lanes mirror the retired status enum, so no ticket changes column.
 */
export function ensureBoards(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      asc_issuer_id TEXT NOT NULL DEFAULT '',
      asc_key_id TEXT NOT NULL DEFAULT '',
      asc_app_id TEXT NOT NULL DEFAULT '',
      asc_private_key TEXT,
      asc_key_filename TEXT,
      asc_key_uploaded_at TEXT,
      sync_limit INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lanes (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      is_import INTEGER NOT NULL DEFAULT 0 CHECK (is_import IN (0, 1))
    );
  `)
  if ((db.prepare('SELECT COUNT(*) AS value FROM boards').get() as { value: number }).value > 0) return false

  const config = getServerConfig()
  const legacyKey = legacyPrivateKey(config.ascPrivateKeyPath)
  const boardId = randomUUID()
  const now = new Date().toISOString()
  const laneIdByName = new Map<string, string>()
  const ticketColumns = tableColumns(db, 'tickets')
  const needsTicketRebuild = ticketColumns.has('status')
  const categoryColumns = tableColumns(db, 'categories')
  const needsCategoryRebuild = !categoryColumns.has('board_id')
  const syncRunColumns = tableColumns(db, 'sync_runs')

  db.pragma('foreign_keys = OFF')
  try {
    db.exec('BEGIN IMMEDIATE')

    db.prepare(`INSERT INTO boards (id, name, position, asc_issuer_id, asc_key_id, asc_app_id, asc_private_key, asc_key_filename, asc_key_uploaded_at, created_at)
      VALUES (?, 'Workboard', 0, ?, ?, ?, ?, ?, ?, ?)`).run(
      boardId,
      config.ascIssuerId,
      config.ascKeyId,
      config.ascAppId,
      legacyKey && secretKeyAvailable() ? encryptSecret(legacyKey.pem) : null,
      legacyKey && secretKeyAvailable() ? legacyKey.filename : null,
      legacyKey && secretKeyAvailable() ? now : null,
      now
    )

    const insertLane = db.prepare('INSERT INTO lanes (id, board_id, name, position, is_import) VALUES (?, ?, ?, ?, ?)')
    defaultLanes.forEach((lane, position) => {
      const id = randomUUID()
      laneIdByName.set(lane.name, id)
      insertLane.run(id, boardId, lane.name, position, lane.isImport ? 1 : 0)
    })

    if (needsCategoryRebuild) {
      db.exec(`
        CREATE TABLE categories_migration (
          id TEXT PRIMARY KEY,
          board_id TEXT REFERENCES boards(id) ON DELETE CASCADE,
          name TEXT NOT NULL COLLATE NOCASE
        );
      `)
      db.prepare('INSERT INTO categories_migration (id, board_id, name) SELECT id, ?, name FROM categories').run(boardId)
      db.exec('DROP TABLE categories; ALTER TABLE categories_migration RENAME TO categories;')
    }

    if (needsTicketRebuild) {
      const laneCase = Object.entries(legacyStatusLaneNames)
        .map(([status, name]) => `WHEN ${sqlText(status)} THEN ${sqlText(laneIdByName.get(name)!)}`)
        .join(' ')
      db.exec(`
        CREATE TABLE tickets_migration (
          id TEXT PRIMARY KEY,
          ticket_number INTEGER NOT NULL UNIQUE,
          board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          lane_id TEXT NOT NULL REFERENCES lanes(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          comment TEXT NOT NULL DEFAULT '',
          position INTEGER NOT NULL,
          priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
          due_date TEXT,
          build_number TEXT,
          source TEXT NOT NULL CHECK (source IN ('manual', 'testflight_screenshot', 'testflight_crash')),
          external_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          author_first_name TEXT,
          author_last_name TEXT,
          author_email TEXT,
          category_id TEXT REFERENCES categories(id) ON DELETE SET NULL
        );
        INSERT INTO tickets_migration (id, ticket_number, board_id, lane_id, title, description, comment, position, priority, due_date, build_number, source, external_id, created_at, updated_at, archived_at, author_first_name, author_last_name, author_email, category_id)
        SELECT id, ticket_number, ${sqlText(boardId)},
          CASE status ${laneCase} ELSE ${sqlText(laneIdByName.get('Backlog')!)} END,
          title, description, comment, position, priority, due_date, build_number, source, external_id, created_at, updated_at, archived_at,
          author_first_name, author_last_name, author_email, category_id
        FROM tickets;
        DROP TABLE tickets;
        ALTER TABLE tickets_migration RENAME TO tickets;
      `)
    }

    if (!syncRunColumns.has('board_id')) {
      db.exec('ALTER TABLE sync_runs ADD COLUMN board_id TEXT REFERENCES boards(id) ON DELETE CASCADE')
      db.prepare('UPDATE sync_runs SET board_id = ?').run(boardId)
    }

    db.exec('COMMIT')
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw error
  } finally {
    db.pragma('foreign_keys = ON')
  }

  db.exec(boardIndexes)
  const foreignKeyErrors = db.pragma('foreign_key_check') as unknown[]
  if (foreignKeyErrors.length) throw new Error('The SQLite migration created invalid foreign keys.')
  return true
}

/**
 * Labels used to be global: one row per name, shared by every board. They become a per-board
 * taxonomy here, which also means the old `UNIQUE(name)` has to go — and SQLite can only drop
 * a constraint by rebuilding the table.
 */
export function ensureLabelBoard(db: Database.Database) {
  if (tableColumns(db, 'labels').has('board_id')) return false

  const owners = db.prepare(`
    SELECT tl.label_id AS labelId, t.board_id AS boardId
    FROM ticket_labels tl JOIN tickets t ON t.id = tl.ticket_id
    GROUP BY tl.label_id, t.board_id
  `).all() as Array<{ labelId: string; boardId: string }>

  const boardsByLabel = new Map<string, string[]>()
  for (const row of owners) {
    const boards = boardsByLabel.get(row.labelId) || []
    boards.push(row.boardId)
    boardsByLabel.set(row.labelId, boards)
  }

  db.pragma('foreign_keys = OFF')
  try {
    db.exec('BEGIN IMMEDIATE')
    db.exec(`
      CREATE TABLE labels_migration (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE
      );
    `)

    const legacy = db.prepare('SELECT id, name FROM labels').all() as Array<{ id: string; name: string }>
    const insert = db.prepare('INSERT INTO labels_migration (id, board_id, name) VALUES (?, ?, ?)')
    const repoint = db.prepare(`
      UPDATE ticket_labels SET label_id = ?
      WHERE label_id = ? AND ticket_id IN (SELECT id FROM tickets WHERE board_id = ?)
    `)

    for (const label of legacy) {
      // A label nobody uses simply does not survive — that is the new rule applied to the backlog.
      const boards = boardsByLabel.get(label.id) || []
      boards.forEach((boardId, index) => {
        if (index === 0) {
          insert.run(label.id, boardId, label.name)
          return
        }
        // The same name on a second board becomes its own row, and that board's links follow it.
        const id = randomUUID()
        insert.run(id, boardId, label.name)
        repoint.run(id, label.id, boardId)
      })
    }

    db.exec('DROP TABLE labels; ALTER TABLE labels_migration RENAME TO labels;')
    db.exec('DELETE FROM ticket_labels WHERE label_id NOT IN (SELECT id FROM labels)')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.pragma('foreign_keys = ON')
  }

  const foreignKeyErrors = db.pragma('foreign_key_check') as unknown[]
  if (foreignKeyErrors.length) throw new Error('The SQLite migration created invalid foreign keys.')
  return true
}

/** Categories carry a colour tone so they stand apart on the board. */
export function ensureCategoryColor(db: Database.Database) {
  if (tableColumns(db, 'categories').has('color')) return false
  db.exec("ALTER TABLE categories ADD COLUMN color TEXT NOT NULL DEFAULT 'neutral'")
  return true
}

/** Lane colours never reached the UI, so the column and its picker are gone. */
export function ensureLanesWithoutColor(db: Database.Database) {
  if (!tableColumns(db, 'lanes').has('color')) return false
  db.exec('ALTER TABLE lanes DROP COLUMN color')
  return true
}

export function ensureBoardSyncLimit(db: Database.Database) {
  const hasSyncLimit = tableColumns(db, 'boards').has('sync_limit')
  if (!hasSyncLimit) db.exec(`ALTER TABLE boards ADD COLUMN sync_limit INTEGER NOT NULL DEFAULT ${DEFAULT_SYNC_LIMIT}`)
  return !hasSyncLimit
}

/** The instance owner seeded on first start, read from the bootstrap environment variables. */
export interface OwnerSeed {
  email: string
  firstName: string
  lastName: string
  passwordHash: string
}

/**
 * Introduces accounts and board membership. On a database that has never had a user, the
 * bootstrap environment variables become the owner and every existing board is handed to
 * them, so an installation that upgrades keeps signing in with the credentials it had.
 */
export function ensureUsers(db: Database.Database, seed: OwnerSeed | null = null) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
      status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
      session_version INTEGER NOT NULL DEFAULT 1,
      invite_token_hash TEXT,
      invite_expires_at TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS board_members (
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'viewer')),
      added_at TEXT NOT NULL,
      PRIMARY KEY (board_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_board_members_user ON board_members(user_id);
  `)

  const populated = (db.prepare('SELECT COUNT(*) AS value FROM users').get() as { value: number }).value > 0
  if (populated || !seed) return false

  const id = randomUUID()
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare(`
      INSERT INTO users (id, email, first_name, last_name, password_hash, role, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'owner', 'active', ?)
    `).run(id, seed.email, seed.firstName, seed.lastName, seed.passwordHash, now)
    const boards = db.prepare('SELECT id FROM boards').all() as Array<{ id: string }>
    const addMember = db.prepare("INSERT OR IGNORE INTO board_members (board_id, user_id, role, added_at) VALUES (?, ?, 'admin', ?)")
    for (const board of boards) addMember.run(board.id, id, now)
  })()
  invalidateUserDirectory()
  return true
}

export function ensureTicketAssignee(db: Database.Database) {
  const hasAssignee = tableColumns(db, 'tickets').has('assignee_email')
  if (!hasAssignee) db.exec('ALTER TABLE tickets ADD COLUMN assignee_email TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(board_id, assignee_email)')
  return !hasAssignee
}

/**
 * Turns the single internal comment field into a thread. The old text becomes the first
 * entry, attributed to the ticket author, and the column goes away — leaving it in place
 * would keep a second, silently diverging copy of the same information.
 *
 * Deliberately not named `ensureTicketComment`: that legacy migration adds the very column
 * this one removes, and runs earlier in `getDb`. On a pre-boards database the order is
 * add, rebuild, migrate, drop, which is why this has to stay last.
 */
export function ensureTicketCommentThread(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_comments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      author_email TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket ON ticket_comments(ticket_id, created_at);
  `)
  if (!tableColumns(db, 'tickets').has('comment')) return false

  const carried = db.prepare(`
    SELECT id, comment, author_email, created_at, updated_at
    FROM tickets
    WHERE comment IS NOT NULL AND TRIM(comment) <> ''
  `).all() as Array<{ id: string; comment: string; author_email: string | null; created_at: string; updated_at: string }>

  db.transaction(() => {
    const insert = db.prepare('INSERT INTO ticket_comments (id, ticket_id, author_email, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    for (const ticket of carried) {
      // An imported ticket has no author; its carried-over note becomes an unattributed entry.
      insert.run(randomUUID(), ticket.id, ticket.author_email || '', ticket.comment, ticket.updated_at || ticket.created_at, ticket.updated_at || ticket.created_at)
    }
    db.exec('ALTER TABLE tickets DROP COLUMN comment')
  })()
  return true
}

export function ensureActivityLog(db: Database.Database) {
  const existed = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'ticket_activity'").get())
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_activity (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      actor_email TEXT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_activity_ticket ON ticket_activity(ticket_id, created_at DESC);
  `)
  return !existed
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

type BoardRow = {
  id: string; name: string; position: number
  asc_issuer_id: string; asc_key_id: string; asc_app_id: string
  asc_private_key: string | null; asc_key_filename: string | null; asc_key_uploaded_at: string | null
  sync_limit: number; created_at: string
}

type LaneRow = { id: string; board_id: string; name: string; position: number; is_import: number }

type TicketRow = {
  id: string; ticket_number: number; board_id: string; lane_id: string; title: string; description: string
  position: number; priority: TicketPriority; due_date: string | null; build_number: string | null
  source: TicketSource; external_id: string | null; created_at: string; updated_at: string; archived_at: string | null
  category_id: string | null; author_first_name: string | null; author_last_name: string | null; author_email: string | null
  assignee_email: string | null
}

function toBoard(row: BoardRow): Board {
  return { id: row.id, name: row.name, position: row.position, syncLimit: row.sync_limit, createdAt: row.created_at }
}

function toCredentials(row: BoardRow): BoardCredentials {
  return {
    issuerId: row.asc_issuer_id,
    keyId: row.asc_key_id,
    appId: row.asc_app_id,
    keyFilename: row.asc_key_filename,
    keyUploadedAt: row.asc_key_uploaded_at,
    complete: Boolean(row.asc_issuer_id && row.asc_key_id && row.asc_app_id && row.asc_private_key)
  }
}

function toLane(row: LaneRow): Lane {
  return { id: row.id, boardId: row.board_id, name: row.name, position: row.position, isImport: Boolean(row.is_import) }
}

/** Who is asking. Omitted for internal callers and tests, which see every board as an admin. */
export interface BoardViewer {
  userId: string
  instanceAdmin: boolean
}

export function boardMembers(boardId: string): BoardMember[] {
  return (getDb().prepare(`
    SELECT u.id AS userId, u.email, u.first_name AS firstName, u.last_name AS lastName, u.status, m.role, m.added_at AS addedAt
    FROM board_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.board_id = ?
    ORDER BY u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE, u.email COLLATE NOCASE
  `).all(boardId)) as BoardMember[]
}

function toBoardSummary(row: BoardRow, viewer?: BoardViewer | null): BoardSummary {
  const members = boardMembers(row.id)
  const own = viewer ? members.find(member => member.userId === viewer.userId)?.role || null : null
  return {
    ...toBoard(row),
    credentials: toCredentials(row),
    lanes: listLanes(row.id),
    ticketCount: (getDb().prepare('SELECT COUNT(*) AS value FROM tickets WHERE board_id = ? AND archived_at IS NULL').get(row.id) as { value: number }).value,
    members,
    // An instance admin keeps full control of every board — outranking even a membership
    // row that says otherwise — so nobody can lock themselves out of their own server.
    // No viewer at all means an internal call, which is likewise unrestricted.
    role: !viewer || viewer.instanceAdmin ? 'admin' : own || 'viewer'
  }
}

export function listBoards(viewer?: BoardViewer | null): BoardSummary[] {
  const db = getDb()
  const scoped = viewer && !viewer.instanceAdmin
  const rows = (scoped
    ? db.prepare(`
        SELECT b.* FROM boards b
        JOIN board_members m ON m.board_id = b.id AND m.user_id = ?
        ORDER BY b.position, b.created_at
      `).all(viewer.userId)
    : db.prepare('SELECT * FROM boards ORDER BY position, created_at').all()) as BoardRow[]
  return rows.map(row => toBoardSummary(row, viewer))
}

/** The boards a user may see, or null when they may see all of them. */
export function accessibleBoardIds(viewer: BoardViewer): string[] | null {
  if (viewer.instanceAdmin) return null
  return (getDb().prepare('SELECT board_id FROM board_members WHERE user_id = ?').all(viewer.userId) as Array<{ board_id: string }>)
    .map(row => row.board_id)
}

/** The role a user holds on a board, or null when they hold none. */
export function boardRoleFor(boardId: string, userId: string): BoardRole | null {
  const row = getDb().prepare('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?').get(boardId, userId) as { role: BoardRole } | undefined
  return row?.role || null
}

export function findBoard(id: string): Board | null {
  const row = getDb().prepare('SELECT * FROM boards WHERE id = ?').get(id) as BoardRow | undefined
  return row ? toBoard(row) : null
}

export function findBoardSummary(id: string, viewer?: BoardViewer | null): BoardSummary | null {
  const row = getDb().prepare('SELECT * FROM boards WHERE id = ?').get(id) as BoardRow | undefined
  return row ? toBoardSummary(row, viewer) : null
}

export function countBoards(): number {
  return (getDb().prepare('SELECT COUNT(*) AS value FROM boards').get() as { value: number }).value
}

export function createBoard(name: string, creatorId: string | null = null): BoardSummary {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM boards').get() as { position: number }).position
  db.transaction(() => {
    db.prepare('INSERT INTO boards (id, name, position, created_at) VALUES (?, ?, ?, ?)').run(id, name, position, now)
    const insertLane = db.prepare('INSERT INTO lanes (id, board_id, name, position, is_import) VALUES (?, ?, ?, ?, ?)')
    newBoardLanes.forEach((lane, lanePosition) => insertLane.run(randomUUID(), id, lane.name, lanePosition, lane.isImport ? 1 : 0))
    if (creatorId) {
      db.prepare("INSERT INTO board_members (board_id, user_id, role, added_at) VALUES (?, ?, 'admin', ?)").run(id, creatorId, now)
    }
  })()
  return findBoardSummary(id, creatorId ? { userId: creatorId, instanceAdmin: false } : null)!
}

export interface BoardUpdateInput {
  name?: string
  issuerId?: string
  keyId?: string
  appId?: string
  syncLimit?: number
}

export function updateBoard(id: string, input: BoardUpdateInput, viewer?: BoardViewer | null): BoardSummary | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM boards WHERE id = ?').get(id) as BoardRow | undefined
  if (!row) return null
  db.prepare('UPDATE boards SET name = ?, asc_issuer_id = ?, asc_key_id = ?, asc_app_id = ?, sync_limit = ? WHERE id = ?').run(
    input.name ?? row.name,
    input.issuerId ?? row.asc_issuer_id,
    input.keyId ?? row.asc_key_id,
    input.appId ?? row.asc_app_id,
    input.syncLimit ?? row.sync_limit,
    id
  )
  return findBoardSummary(id, viewer)
}

/** Returns the ids of the deleted tickets so the caller can drop their attachment folders. */
export function deleteBoard(id: string): { ticketIds: string[] } | null {
  const db = getDb()
  if (!findBoard(id)) return null
  const ticketIds = (db.prepare('SELECT id FROM tickets WHERE board_id = ?').all(id) as Array<{ id: string }>).map(row => row.id)
  db.prepare('DELETE FROM boards WHERE id = ?').run(id)
  return { ticketIds }
}

export function setBoardPrivateKey(id: string, pem: string, filename: string, viewer?: BoardViewer | null): BoardSummary | null {
  const db = getDb()
  if (!findBoard(id)) return null
  db.prepare('UPDATE boards SET asc_private_key = ?, asc_key_filename = ?, asc_key_uploaded_at = ? WHERE id = ?')
    .run(encryptSecret(pem), filename, new Date().toISOString(), id)
  return findBoardSummary(id, viewer)
}

export function clearBoardPrivateKey(id: string, viewer?: BoardViewer | null): BoardSummary | null {
  const db = getDb()
  if (!findBoard(id)) return null
  db.prepare('UPDATE boards SET asc_private_key = NULL, asc_key_filename = NULL, asc_key_uploaded_at = NULL WHERE id = ?').run(id)
  return findBoardSummary(id, viewer)
}

/** Server-only: decrypts the stored key. Never expose the result over the API. */
export function boardSyncCredentials(id: string): { issuerId: string; keyId: string; appId: string; privateKeyPem: string | null; syncLimit: number } | null {
  const row = getDb().prepare('SELECT * FROM boards WHERE id = ?').get(id) as BoardRow | undefined
  if (!row) return null
  return {
    issuerId: row.asc_issuer_id,
    keyId: row.asc_key_id,
    appId: row.asc_app_id,
    privateKeyPem: row.asc_private_key ? decryptSecret(row.asc_private_key) : null,
    syncLimit: row.sync_limit
  }
}

export function listLanes(boardId: string): LaneSummary[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM lanes WHERE board_id = ? ORDER BY position, name').all(boardId) as LaneRow[]
  const counts = db.prepare(`
    SELECT lane_id, SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END) AS archived
    FROM tickets WHERE board_id = ? GROUP BY lane_id
  `).all(boardId) as Array<{ lane_id: string; active: number; archived: number }>
  const countByLane = new Map(counts.map(row => [row.lane_id, row]))
  return rows.map(row => ({
    ...toLane(row),
    ticketCount: countByLane.get(row.id)?.active || 0,
    archivedCount: countByLane.get(row.id)?.archived || 0
  }))
}

export function findLane(id: string): Lane | null {
  const row = getDb().prepare('SELECT * FROM lanes WHERE id = ?').get(id) as LaneRow | undefined
  return row ? toLane(row) : null
}

export function importLaneFor(boardId: string): Lane | null {
  const row = getDb().prepare('SELECT * FROM lanes WHERE board_id = ? AND is_import = 1').get(boardId) as LaneRow | undefined
  return row ? toLane(row) : null
}

/** Where manual tickets are created and archived tickets land when their lane disappears. */
export function defaultLaneFor(boardId: string): Lane | null {
  const db = getDb()
  const row = (db.prepare('SELECT * FROM lanes WHERE board_id = ? AND is_import = 0 ORDER BY position LIMIT 1').get(boardId)
    || db.prepare('SELECT * FROM lanes WHERE board_id = ? ORDER BY position LIMIT 1').get(boardId)) as LaneRow | undefined
  return row ? toLane(row) : null
}

export function createLane(boardId: string, name: string): Lane | null {
  const db = getDb()
  if (!findBoard(boardId)) return null
  const id = randomUUID()
  const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM lanes WHERE board_id = ?').get(boardId) as { position: number }).position
  db.prepare('INSERT INTO lanes (id, board_id, name, position, is_import) VALUES (?, ?, ?, ?, 0)').run(id, boardId, name, position)
  return findLane(id)
}

export function updateLane(id: string, input: { name?: string }): Lane | null {
  const db = getDb()
  const lane = findLane(id)
  if (!lane) return null
  db.prepare('UPDATE lanes SET name = ? WHERE id = ?').run(input.name ?? lane.name, id)
  return findLane(id)
}

export function reorderLanes(boardId: string, orderedIds: string[]): LaneSummary[] | null {
  const db = getDb()
  const existing = listLanes(boardId)
  if (!existing.length) return null
  const known = new Set(existing.map(lane => lane.id))
  if (orderedIds.length !== known.size || orderedIds.some(id => !known.has(id))) return null
  const update = db.prepare('UPDATE lanes SET position = ? WHERE id = ? AND board_id = ?')
  db.transaction(() => orderedIds.forEach((id, position) => update.run(position, id, boardId)))()
  return listLanes(boardId)
}

export type LaneDeleteMode = 'move' | 'archive'

export class LaneDeleteError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message)
  }
}

/**
 * Removes a lane. Its tickets either move to `targetLaneId` or are archived; archived
 * tickets are still reassigned to a surviving lane so restoring them has a destination.
 */
export function deleteLane(id: string, mode: LaneDeleteMode, targetLaneId?: string): LaneSummary[] {
  const db = getDb()
  const lane = findLane(id)
  if (!lane) throw new LaneDeleteError(404, 'Lane not found.')
  if (lane.isImport) throw new LaneDeleteError(409, 'The import lane cannot be deleted.')
  const siblings = listLanes(lane.boardId).filter(item => item.id !== id)
  if (!siblings.length) throw new LaneDeleteError(409, 'A board needs at least one lane.')

  const fallback = siblings.find(item => !item.isImport) || siblings[0]!
  const target = mode === 'move'
    ? siblings.find(item => item.id === targetLaneId)
    : fallback
  if (mode === 'move' && !target) throw new LaneDeleteError(422, 'Pick a lane to move the tickets to.')

  const now = new Date().toISOString()
  db.transaction(() => {
    if (mode === 'archive') {
      db.prepare('UPDATE tickets SET archived_at = ?, updated_at = ? WHERE lane_id = ? AND archived_at IS NULL').run(now, now, id)
    }
    db.prepare('UPDATE tickets SET lane_id = ?, updated_at = ? WHERE lane_id = ?').run(target!.id, now, id)
    db.prepare('DELETE FROM lanes WHERE id = ?').run(id)
    if (mode === 'move') reindexLane(target!.id)
    const remaining = db.prepare('SELECT id FROM lanes WHERE board_id = ? ORDER BY position, name').all(lane.boardId) as Array<{ id: string }>
    const update = db.prepare('UPDATE lanes SET position = ? WHERE id = ?')
    remaining.forEach((item, position) => update.run(position, item.id))
  })()
  return listLanes(lane.boardId)
}

function hydrateTicket(row: TicketRow): Ticket {
  const db = getDb()
  const category = row.category_id
    ? db.prepare('SELECT id, name, color FROM categories WHERE id = ?').get(row.category_id) as Category | undefined
    : undefined
  const labels = db.prepare(`SELECT l.id, l.name FROM labels l JOIN ticket_labels tl ON tl.label_id = l.id WHERE tl.ticket_id = ? ORDER BY l.name`).all(row.id) as Label[]
  const feedbackRow = db.prepare('SELECT * FROM apple_feedback WHERE ticket_id = ?').get(row.id) as Record<string, string | null> | undefined
  const attachmentRows = db.prepare('SELECT id, kind, filename, mime_type, size FROM attachments WHERE ticket_id = ? ORDER BY created_at').all(row.id) as Array<{ id: string; kind: Attachment['kind']; filename: string; mime_type: string; size: number }>
  const todoRows = db.prepare('SELECT id, text, completed, position FROM ticket_todos WHERE ticket_id = ? ORDER BY position').all(row.id) as Array<{ id: string; text: string; completed: number; position: number }>
  const commentCount = (db.prepare('SELECT COUNT(*) AS value FROM ticket_comments WHERE ticket_id = ?').get(row.id) as { value: number }).value
  const feedback: AppleFeedback | null = feedbackRow ? {
    feedbackType: feedbackRow.feedback_type as 'screenshot' | 'crash',
    comment: feedbackRow.comment ?? null,
    testerEmail: feedbackRow.tester_email ?? null,
    tester: resolvePerson(feedbackRow.tester_email),
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
  const author: TicketAuthor | null = resolvePerson(row.author_email, { firstName: row.author_first_name, lastName: row.author_last_name })
  const todos: TicketTodo[] = todoRows.map(todo => ({
    id: todo.id,
    text: todo.text,
    completed: Boolean(todo.completed),
    position: todo.position
  }))
  return {
    id: row.id,
    ticketNumber: row.ticket_number,
    boardId: row.board_id,
    laneId: row.lane_id,
    title: row.title,
    description: row.description,
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
    assignee: resolvePerson(row.assignee_email),
    commentCount,
    category: category || null,
    labels,
    feedback,
    attachments,
    todos
  }
}

export function listTickets(boardId: string, archived = false): Ticket[] {
  const rows = getDb().prepare(`
    SELECT t.* FROM tickets t
    JOIN lanes l ON l.id = t.lane_id
    WHERE t.board_id = ? AND t.archived_at IS ${archived ? 'NOT ' : ''}NULL
    ORDER BY l.position, t.position, t.created_at
  `).all(boardId) as TicketRow[]
  return rows.map(hydrateTicket)
}

export function findTicket(id: string): Ticket | null {
  const row = getDb().prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined
  return row ? hydrateTicket(row) : null
}

export function listCategories(boardId: string): CategorySummary[] {
  return getDb().prepare(`
    SELECT c.id, c.name, c.color, COUNT(t.id) AS ticketCount
    FROM categories c
    LEFT JOIN tickets t ON t.category_id = c.id
    WHERE c.board_id = ?
    GROUP BY c.id, c.name, c.color
    ORDER BY c.name COLLATE NOCASE
  `).all(boardId) as CategorySummary[]
}

export function findCategory(id: string): { id: string; boardId: string; name: string; color: CategoryColor } | null {
  const row = getDb().prepare('SELECT id, board_id, name, color FROM categories WHERE id = ?').get(id) as { id: string; board_id: string; name: string; color: CategoryColor } | undefined
  return row ? { id: row.id, boardId: row.board_id, name: row.name, color: row.color } : null
}

export class CategoryNameTakenError extends Error {
  constructor(message: string) {
    super(message)
  }
}

/** Renaming and recolouring share one call, so a rename cannot lose the colour. */
export function updateCategory(id: string, input: { name?: string; color?: CategoryColor }): Category | null {
  const db = getDb()
  const existing = findCategory(id)
  if (!existing) return null
  const name = input.name?.trim() || existing.name
  // The unique index is board-scoped, so only a sibling of the same board can clash.
  const clash = db.prepare('SELECT id FROM categories WHERE board_id = ? AND name = ? COLLATE NOCASE AND id <> ?')
    .get(existing.boardId, name, id) as { id: string } | undefined
  if (clash) throw new CategoryNameTakenError(`This board already has a category named “${name}”.`)
  db.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').run(name, input.color ?? existing.color, id)
  const row = findCategory(id)!
  return { id: row.id, name: row.name, color: row.color }
}

export function deleteCategory(id: string) {
  return getDb().prepare('DELETE FROM categories WHERE id = ?').run(id).changes > 0
}

function resolveCategoryId(boardId: string, name: string | null | undefined): string | null {
  const cleanName = name?.trim()
  if (!cleanName) return null
  const db = getDb()
  const existing = db.prepare('SELECT id FROM categories WHERE board_id = ? AND name = ? COLLATE NOCASE').get(boardId, cleanName) as { id: string } | undefined
  if (existing) return existing.id
  const id = randomUUID()
  db.prepare('INSERT INTO categories (id, board_id, name) VALUES (?, ?, ?)').run(id, boardId, cleanName)
  return id
}

/** Drops the labels among `labelIds` that no ticket references any more. */
function pruneOrphanLabels(labelIds: string[]) {
  if (!labelIds.length) return
  const db = getDb()
  const placeholders = labelIds.map(() => '?').join(', ')
  db.prepare(`
    DELETE FROM labels
    WHERE id IN (${placeholders})
      AND NOT EXISTS (SELECT 1 FROM ticket_labels WHERE label_id = labels.id)
  `).run(...labelIds)
}

function setTicketLabels(ticketId: string, boardId: string, names: string[]) {
  const db = getDb()
  const previous = (db.prepare('SELECT label_id FROM ticket_labels WHERE ticket_id = ?').all(ticketId) as Array<{ label_id: string }>)
    .map(row => row.label_id)
  db.prepare('DELETE FROM ticket_labels WHERE ticket_id = ?').run(ticketId)

  // Names are matched case-insensitively, so they have to be deduplicated the same way —
  // otherwise “iOS” and “ios” resolve to one row and burn two of the twelve slots.
  const cleanNames: string[] = []
  const seen = new Set<string>()
  for (const name of names.map(value => value.trim()).filter(Boolean)) {
    const key = name.toLocaleLowerCase('en')
    if (seen.has(key)) continue
    seen.add(key)
    cleanNames.push(name)
    if (cleanNames.length === 12) break
  }

  const find = db.prepare('SELECT id FROM labels WHERE board_id = ? AND name = ? COLLATE NOCASE')
  const insertLabel = db.prepare('INSERT INTO labels (id, board_id, name) VALUES (?, ?, ?)')
  const attach = db.prepare('INSERT OR IGNORE INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)')
  for (const name of cleanNames) {
    let label = find.get(boardId, name) as { id: string } | undefined
    if (!label) {
      label = { id: randomUUID() }
      insertLabel.run(label.id, boardId, name)
    }
    attach.run(ticketId, label.id)
  }

  pruneOrphanLabels(previous)
}

export function listLabels(boardId: string): LabelSummary[] {
  return getDb().prepare(`
    SELECT l.id, l.name, COUNT(tl.ticket_id) AS ticketCount
    FROM labels l
    LEFT JOIN ticket_labels tl ON tl.label_id = l.id
    WHERE l.board_id = ?
    GROUP BY l.id, l.name
    ORDER BY l.name COLLATE NOCASE
  `).all(boardId) as LabelSummary[]
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
  priority?: TicketPriority
  dueDate?: string | null
  buildNumber?: string | null
  labels?: string[]
  laneId?: string
  categoryName?: string | null
  todos?: TicketTodoInput[]
  assigneeEmail?: string | null
}

function nextPosition(laneId: string): number {
  return (getDb().prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tickets WHERE lane_id = ? AND archived_at IS NULL').get(laneId) as { position: number }).position
}

/** Appends one entry to a ticket's history. Always called from inside the caller's transaction. */
function recordActivity(ticketId: string, actorEmail: string | null, kind: ActivityKind, payload: Record<string, string | null> = {}) {
  getDb().prepare('INSERT INTO ticket_activity (id, ticket_id, actor_email, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), ticketId, actorEmail, kind, JSON.stringify(payload), new Date().toISOString())
}

export function createTicket(boardId: string, input: TicketInput, author: TicketAuthor | null = null): Ticket | null {
  const db = getDb()
  // A lane may be named by the caller — the board's own lane, or nothing.
  const requested = input.laneId ? findLane(input.laneId) : null
  const lane = requested?.boardId === boardId ? requested : defaultLaneFor(boardId)
  if (!lane) return null
  const id = randomUUID()
  const now = new Date().toISOString()
  const position = nextPosition(lane.id)
  db.transaction(() => {
    const categoryId = resolveCategoryId(boardId, input.categoryName)
    db.prepare(`INSERT INTO tickets (id, ticket_number, board_id, lane_id, title, description, position, priority, due_date, build_number, source, created_at, updated_at, author_first_name, author_last_name, author_email, assignee_email, category_id)
      VALUES (?, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tickets), ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`).run(
      id, boardId, lane.id, input.title, input.description || '', position, input.priority || 'medium',
      input.dueDate || null, input.buildNumber || null, now, now,
      author?.firstName || null, author?.lastName || null, author?.email || null, input.assigneeEmail || null, categoryId
    )
    setTicketLabels(id, boardId, input.labels || [])
    setTicketTodos(id, input.todos || [])
    recordActivity(id, author?.email || null, 'created', { lane: lane.name })
    if (input.assigneeEmail) recordActivity(id, author?.email || null, 'assigned', { to: input.assigneeEmail })
  })()
  return findTicket(id)!
}

export function updateTicket(id: string, input: Partial<TicketInput>, actorEmail: string | null = null): Ticket | null {
  const existing = findTicket(id)
  if (!existing) return null
  const now = new Date().toISOString()
  const priority = input.priority ?? existing.priority
  const dueDate = input.dueDate === undefined ? existing.dueDate : input.dueDate || null
  const assigneeEmail = input.assigneeEmail === undefined ? existing.assignee?.email || null : input.assigneeEmail || null
  getDb().transaction(() => {
    const categoryId = input.categoryName === undefined ? existing.category?.id || null : resolveCategoryId(existing.boardId, input.categoryName)
    getDb().prepare(`UPDATE tickets SET title = ?, description = ?, priority = ?, due_date = ?, build_number = ?, assignee_email = ?, category_id = ?, updated_at = ? WHERE id = ?`).run(
      input.title ?? existing.title,
      input.description ?? existing.description,
      priority,
      dueDate,
      input.buildNumber === undefined ? (existing.source === 'manual' ? existing.buildNumber : null) : input.buildNumber || null,
      assigneeEmail,
      categoryId,
      now,
      id
    )
    if (input.labels) setTicketLabels(id, existing.boardId, input.labels)
    if (input.todos !== undefined) setTicketTodos(id, input.todos)
    if (priority !== existing.priority) recordActivity(id, actorEmail, 'priority', { from: existing.priority, to: priority })
    if (dueDate !== existing.dueDate) recordActivity(id, actorEmail, 'due_date', { from: existing.dueDate, to: dueDate })
    if (assigneeEmail !== (existing.assignee?.email || null)) {
      recordActivity(id, actorEmail, assigneeEmail ? 'assigned' : 'unassigned', { from: existing.assignee?.email || null, to: assigneeEmail })
    }
  })()
  return findTicket(id)
}

function reindexLane(laneId: string, orderedIds?: string[]) {
  const db = getDb()
  const ids = orderedIds
    || (db.prepare('SELECT id FROM tickets WHERE lane_id = ? AND archived_at IS NULL ORDER BY position, created_at').all(laneId) as Array<{ id: string }>).map(row => row.id)
  const update = db.prepare('UPDATE tickets SET lane_id = ?, position = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL')
  const now = new Date().toISOString()
  ids.forEach((id, index) => update.run(laneId, index, now, id))
}

export function moveTicket(id: string, targetLaneId: string, targetIndex: number, actorEmail: string | null = null): Ticket | null {
  const current = findTicket(id)
  if (!current || current.archivedAt) return null
  const targetLane = findLane(targetLaneId)
  if (!targetLane || targetLane.boardId !== current.boardId) return null
  const db = getDb()
  db.transaction(() => {
    const sourceIds = (db.prepare('SELECT id FROM tickets WHERE lane_id = ? AND archived_at IS NULL ORDER BY position, created_at').all(current.laneId) as Array<{ id: string }>).map(row => row.id).filter(ticketId => ticketId !== id)
    const targetIds = current.laneId === targetLaneId
      ? sourceIds
      : (db.prepare('SELECT id FROM tickets WHERE lane_id = ? AND archived_at IS NULL ORDER BY position, created_at').all(targetLaneId) as Array<{ id: string }>).map(row => row.id).filter(ticketId => ticketId !== id)
    const index = Math.max(0, Math.min(targetIndex, targetIds.length))
    targetIds.splice(index, 0, id)
    if (current.laneId !== targetLaneId) {
      reindexLane(current.laneId, sourceIds)
      recordActivity(id, actorEmail, 'moved', { from: findLane(current.laneId)?.name || null, to: targetLane.name })
    }
    reindexLane(targetLaneId, targetIds)
  })()
  return findTicket(id)
}

export function archiveTicket(id: string, actorEmail: string | null = null): Ticket | null {
  const now = new Date().toISOString()
  const result = getDb().prepare('UPDATE tickets SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL').run(now, now, id)
  if (!result.changes) return null
  recordActivity(id, actorEmail, 'archived')
  return findTicket(id)
}

export function restoreTicket(id: string, actorEmail: string | null = null): Ticket | null {
  const db = getDb()
  const ticket = findTicket(id)
  if (!ticket || !ticket.archivedAt) return null
  const lane = findLane(ticket.laneId) || defaultLaneFor(ticket.boardId)
  if (!lane) return null
  const now = new Date().toISOString()
  db.prepare('UPDATE tickets SET archived_at = NULL, lane_id = ?, position = ?, updated_at = ? WHERE id = ?')
    .run(lane.id, nextPosition(lane.id), now, id)
  recordActivity(id, actorEmail, 'restored', { lane: lane.name })
  return findTicket(id)
}

export function latestSyncRun(boardId: string, successOnly = false): SyncRun | null {
  const row = getDb().prepare(`
    SELECT * FROM sync_runs
    WHERE board_id = ? ${successOnly ? "AND status IN ('success','partial')" : ''}
    ORDER BY started_at DESC LIMIT 1
  `).get(boardId) as Record<string, string | number | null> | undefined
  return row ? {
    id: row.id as string,
    boardId: row.board_id as string,
    startedAt: row.started_at as string,
    finishedAt: row.finished_at as string | null,
    status: row.status as SyncRun['status'],
    importedCount: row.imported_count as number,
    skippedCount: row.skipped_count as number,
    failedCount: row.failed_count as number,
    errorMessage: row.error_message as string | null
  } : null
}

export function createSyncRun(boardId: string): SyncRun {
  const id = randomUUID()
  getDb().prepare("INSERT INTO sync_runs (id, board_id, started_at, status) VALUES (?, ?, ?, 'running')").run(id, boardId, new Date().toISOString())
  return latestSyncRun(boardId)!
}

export function finishSyncRun(boardId: string, id: string, status: SyncRun['status'], imported: number, skipped: number, failed: number, error: string | null) {
  getDb().prepare('UPDATE sync_runs SET finished_at = ?, status = ?, imported_count = ?, skipped_count = ?, failed_count = ?, error_message = ? WHERE id = ?')
    .run(new Date().toISOString(), status, imported, skipped, failed, error, id)
  return latestSyncRun(boardId)!
}

export function hasExternalTicket(boardId: string, externalId: string) {
  return Boolean(getDb().prepare('SELECT 1 FROM tickets WHERE board_id = ? AND external_id = ?').get(boardId, externalId))
}

export interface ImportedTicketInput {
  boardId: string
  laneId: string
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
  const position = nextPosition(input.laneId)
  db.transaction(() => {
    db.prepare(`INSERT INTO tickets (id, ticket_number, board_id, lane_id, title, description, position, priority, source, external_id, created_at, updated_at)
      VALUES (?, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tickets), ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`).run(
      id, input.boardId, input.laneId, input.title, position, input.type === 'crash' ? 'high' : 'medium',
      input.type === 'crash' ? 'testflight_crash' : 'testflight_screenshot', input.externalId, now, now
    )
    db.prepare(`INSERT INTO apple_feedback (ticket_id, feedback_type, comment, tester_email, device_model, os_version, locale, build_id, build_version, build_bundle_id, source_created_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.type, input.comment, input.testerEmail, input.deviceModel, input.osVersion, input.locale,
      input.buildId, input.buildVersion, input.buildBundleId, input.sourceCreatedAt, JSON.stringify(input.raw)
    )
    setTicketLabels(id, input.boardId, ['TestFlight', input.type === 'crash' ? 'Crash' : 'Screenshot'])
    // No actor: the ticket came from Apple, not from anyone signed in here.
    recordActivity(id, null, 'created', { source: input.type })
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

/* -------------------------------------------------------------------------- *
 * Accounts, membership, comments, activity
 *
 * Everything person-shaped is keyed by email. Nothing here writes a user id into
 * a ticket, comment, or activity row, which is what lets an address that has no
 * account yet start resolving the moment somebody creates one.
 * -------------------------------------------------------------------------- */

export interface UserRecord {
  id: string
  email: string
  firstName: string
  lastName: string
  passwordHash: string | null
  role: UserRole
  status: UserStatus
  sessionVersion: number
  inviteTokenHash: string | null
  inviteExpiresAt: string | null
  createdAt: string
  lastLoginAt: string | null
}

type UserRow = {
  id: string; email: string; first_name: string; last_name: string; password_hash: string | null
  role: UserRole; status: UserStatus; session_version: number; invite_token_hash: string | null
  invite_expires_at: string | null; created_at: string; last_login_at: string | null
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    passwordHash: row.password_hash,
    role: row.role,
    status: row.status,
    sessionVersion: row.session_version,
    inviteTokenHash: row.invite_token_hash,
    inviteExpiresAt: row.invite_expires_at,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  }
}

export function listUsers(): UserAccount[] {
  return (getDb().prepare(`
    SELECT u.id, u.email, u.first_name AS firstName, u.last_name AS lastName, u.role, u.status,
           u.created_at AS createdAt, u.last_login_at AS lastLoginAt, u.invite_expires_at AS inviteExpiresAt,
           (SELECT COUNT(*) FROM board_members m WHERE m.user_id = u.id) AS boardCount
    FROM users u
    ORDER BY u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE, u.email COLLATE NOCASE
  `).all()) as UserAccount[]
}

export function countUsers(): number {
  return (getDb().prepare('SELECT COUNT(*) AS value FROM users').get() as { value: number }).value
}

export function findUser(id: string): UserRecord | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
  return row ? toUser(row) : null
}

export function findUserByEmail(email: string): UserRecord | null {
  const row = getDb().prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email.trim()) as UserRow | undefined
  return row ? toUser(row) : null
}

export function findUserByInviteToken(tokenHash: string): UserRecord | null {
  const row = getDb().prepare('SELECT * FROM users WHERE invite_token_hash = ?').get(tokenHash) as UserRow | undefined
  return row ? toUser(row) : null
}

export class EmailTakenError extends Error {
  constructor() { super('An account with this email address already exists.') }
}

export interface UserCreateInput {
  email: string
  firstName: string
  lastName: string
  role: UserRole
}

export function createUser(input: UserCreateInput): UserRecord {
  const db = getDb()
  const email = input.email.trim().toLowerCase()
  if (findUserByEmail(email)) throw new EmailTakenError()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO users (id, email, first_name, last_name, role, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'invited', ?)
  `).run(id, email, input.firstName, input.lastName, input.role, new Date().toISOString())
  invalidateUserDirectory()
  return findUser(id)!
}

export interface UserUpdateInput {
  firstName?: string
  lastName?: string
  role?: UserRole
  status?: UserStatus
}

export function updateUser(id: string, input: UserUpdateInput): UserRecord | null {
  const existing = findUser(id)
  if (!existing) return null
  const status = input.status ?? existing.status
  // Locking an account out only helps if the sessions it already has stop working.
  const sessionVersion = status === 'disabled' && existing.status !== 'disabled' ? existing.sessionVersion + 1 : existing.sessionVersion
  getDb().prepare('UPDATE users SET first_name = ?, last_name = ?, role = ?, status = ?, session_version = ? WHERE id = ?').run(
    input.firstName ?? existing.firstName,
    input.lastName ?? existing.lastName,
    input.role ?? existing.role,
    status,
    sessionVersion,
    id
  )
  invalidateUserDirectory()
  return findUser(id)
}

export function deleteUser(id: string): boolean {
  const changes = getDb().prepare('DELETE FROM users WHERE id = ?').run(id).changes
  if (changes) invalidateUserDirectory()
  return changes > 0
}

/** Stores a password, activates the account, and retires the invite and every live session. */
export function setUserPassword(id: string, passwordHash: string): UserRecord | null {
  const existing = findUser(id)
  if (!existing) return null
  getDb().prepare(`
    UPDATE users
    SET password_hash = ?, status = 'active', invite_token_hash = NULL, invite_expires_at = NULL, session_version = session_version + 1
    WHERE id = ?
  `).run(passwordHash, id)
  invalidateUserDirectory()
  return findUser(id)
}

export function setInviteToken(id: string, tokenHash: string, expiresAt: string): UserRecord | null {
  const changes = getDb().prepare('UPDATE users SET invite_token_hash = ?, invite_expires_at = ? WHERE id = ?').run(tokenHash, expiresAt, id).changes
  return changes ? findUser(id) : null
}

/** Retires an outstanding invitation without touching the account it belongs to. */
export function clearInviteToken(id: string): UserRecord | null {
  const changes = getDb().prepare('UPDATE users SET invite_token_hash = NULL, invite_expires_at = NULL WHERE id = ?').run(id).changes
  return changes ? findUser(id) : null
}

export function touchLastLogin(id: string) {
  getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), id)
}

export function setBoardMember(boardId: string, userId: string, role: BoardRole): BoardMember | null {
  if (!findBoard(boardId) || !findUser(userId)) return null
  getDb().prepare(`
    INSERT INTO board_members (board_id, user_id, role, added_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (board_id, user_id) DO UPDATE SET role = excluded.role
  `).run(boardId, userId, role, new Date().toISOString())
  return boardMembers(boardId).find(member => member.userId === userId) || null
}

export function removeBoardMember(boardId: string, userId: string): boolean {
  return getDb().prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?').run(boardId, userId).changes > 0
}

export function countBoardAdmins(boardId: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS value FROM board_members WHERE board_id = ? AND role = 'admin'").get(boardId) as { value: number }).value
}

type CommentRow = { id: string; ticket_id: string; author_email: string; body: string; created_at: string; updated_at: string }

function toComment(row: CommentRow): TicketComment {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    author: resolvePerson(row.author_email),
    authorEmail: row.author_email,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listComments(ticketId: string): TicketComment[] {
  const rows = getDb().prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at, rowid').all(ticketId) as CommentRow[]
  return rows.map(toComment)
}

export function findComment(id: string): TicketComment | null {
  const row = getDb().prepare('SELECT * FROM ticket_comments WHERE id = ?').get(id) as CommentRow | undefined
  return row ? toComment(row) : null
}

export function createComment(ticketId: string, authorEmail: string, body: string): TicketComment | null {
  const db = getDb()
  if (!db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(ticketId)) return null
  const id = randomUUID()
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare('INSERT INTO ticket_comments (id, ticket_id, author_email, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, ticketId, authorEmail, body, now, now)
    recordActivity(ticketId, authorEmail, 'commented')
  })()
  return findComment(id)
}

export function updateComment(id: string, body: string): TicketComment | null {
  const changes = getDb().prepare('UPDATE ticket_comments SET body = ?, updated_at = ? WHERE id = ?').run(body, new Date().toISOString(), id).changes
  return changes ? findComment(id) : null
}

export function deleteComment(id: string): boolean {
  return getDb().prepare('DELETE FROM ticket_comments WHERE id = ?').run(id).changes > 0
}

export function listActivity(ticketId: string, limit = 100): TicketActivityEntry[] {
  const rows = getDb().prepare('SELECT * FROM ticket_activity WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(ticketId, limit) as Array<{ id: string; ticket_id: string; actor_email: string | null; kind: ActivityKind; payload: string; created_at: string }>
  return rows.map(row => ({
    id: row.id,
    ticketId: row.ticket_id,
    actor: resolvePerson(row.actor_email),
    kind: row.kind,
    payload: safeJson(row.payload),
    createdAt: row.created_at,
  }))
}

function safeJson(value: string): Record<string, string | null> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
