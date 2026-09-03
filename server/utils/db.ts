import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ActivityKind, AppleFeedback, Attachment, Board, BoardCredentials, BoardMember, BoardRole, BoardSummary, Category, CategoryColor,
  CategorySummary, Label, LabelSummary, Lane, LaneSummary, Person, SyncRun, Ticket, TicketActivityEntry, TicketAuthor, TicketComment,
  TicketPriority, TicketSource, TicketTodo, TicketTodoInput, TicketType, TicketTypeColor, TicketTypeIcon, TicketTypeIconName, TicketTypeRef, TicketTypeSummary,
  UserAccount, UserBoardMembership, UserRole, UserStatus, Workspace, WorkspaceMember, WorkspaceRole, WorkspaceSummary
} from '../../shared/types/domain'
import type { Actor, ActorChannel } from './actor'
import { DEFAULT_TICKET_TYPES, DEFAULT_WORKSPACE_NAME } from '../../shared/utils/constants'
import { decryptSecret, encryptSecret, secretKeyAvailable } from './secret-box'
import { hashStoredPassword } from './password'
import { getServerConfig } from './config'

let database: Database.Database | null = null

/** Whether a `users` row is somebody who can sign in, or merely somebody we know of. */
type UserKind = 'account' | 'contact' | 'service'

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
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  asc_issuer_id TEXT NOT NULL DEFAULT '',
  asc_key_id TEXT NOT NULL DEFAULT '',
  asc_app_id TEXT NOT NULL DEFAULT '',
  asc_private_key TEXT,
  asc_key_filename TEXT,
  asc_key_uploaded_at TEXT,
  sync_limit INTEGER NOT NULL DEFAULT 100,
  auto_author INTEGER NOT NULL DEFAULT 1 CHECK (auto_author IN (0, 1)),
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
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
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
  tester_id TEXT REFERENCES users(id) ON DELETE SET NULL,
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
  email TEXT UNIQUE COLLATE NOCASE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  kind TEXT NOT NULL DEFAULT 'account' CHECK (kind IN ('account', 'contact')),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT CHECK (status IS NULL OR status IN ('invited', 'active', 'disabled')),
  session_version INTEGER NOT NULL DEFAULT 1,
  invite_token_hash TEXT,
  invite_expires_at TEXT,
  anonymized_at TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS board_members (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'viewer')),
  -- Whether this membership may be worked through a token — the API, or an agent over MCP.
  -- Another axis than the role, not a rank above it: it says how somebody may act, not how much.
  may_automate INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  PRIMARY KEY (board_id, user_id)
);
CREATE TABLE IF NOT EXISTS ticket_comments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_activity (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
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

// Kept out of `boardIndexes`, which `ensureBoards` execs while tickets still name people
// by email — the columns these cover do not exist until `ensurePersonIdentity` has run.
const personIndexes = `
CREATE INDEX IF NOT EXISTS idx_users_kind ON users(kind);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(board_id, assignee_id);
CREATE INDEX IF NOT EXISTS idx_tickets_author ON tickets(board_id, author_id);
`

// Kept out of `boardIndexes`, which `ensureBoards` execs before labels are board-scoped.
const labelIndexes = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_board_name ON labels(board_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_ticket_labels_label ON ticket_labels(label_id);
`

/** How many of the newest feedback submissions a sync looks at, per feedback type. */
export const DEFAULT_SYNC_LIMIT = 100

/** The type a board's imports land with unless somebody picks another: the plain "Ticket". */
export const DEFAULT_IMPORT_TYPE_NAME = 'Ticket'

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
  const seededOwner = ensureUsers(database, configuredOwnerSeed())
  if (seededOwner && !process.env.APP_PASSWORD_HASH?.trim() && process.env.APP_ADMIN_PASSWORD?.trim()) {
    console.info('[open-bugster] Owner account seeded from APP_ADMIN_PASSWORD. The variable is never read again — you can remove it now.')
  }
  warnWhenNobodyCanSignIn(database)
  ensureTicketAssignee(database)
  ensureTicketCommentThread(database)
  ensureActivityLog(database)
  ensureBoardAutoAuthor(database)
  ensureBoardDescription(database)
  // Last of the email-era migrations: every one above still speaks in email columns.
  ensurePersonIdentity(database)
  // From here on, person ids only.
  ensureActorContext(database)
  ensureAuditLog(database)
  // Before `personIndexes` below, which puts `idx_users_kind` back after the table rebuild.
  ensureServiceIdentities(database)
  ensureApiTokens(database)
  ensureIdempotencyKeys(database)
  ensureWebhooks(database)
  ensureBoardMemberAutomation(database)
  ensureWorkspaces(database)
  ensureWorkspaceDescription(database)
  ensureTicketTypes(database)
  // After `ensureTicketTypes`: the column references the table that migration creates.
  ensureBoardImportType(database)
  // Not in `boardIndexes`: that block also runs inside `ensureBoards`, before an upgrading
  // database has been given the ticket_activity table. Serves the board-wide digest query.
  database.exec('CREATE INDEX IF NOT EXISTS idx_ticket_activity_created ON ticket_activity(created_at DESC)')
  database.exec(boardIndexes)
  database.exec(personIndexes)
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
 * The bootstrap credential comes in one of two shapes: APP_PASSWORD_HASH for operators
 * who never want the password on disk, and plain APP_ADMIN_PASSWORD for everyone else,
 * hashed here at the moment of seeding. The hash wins when both are set, so a leftover
 * plain password cannot silently replace a deliberately provided hash.
 */
function configuredOwnerPasswordHash(): string {
  const hash = process.env.APP_PASSWORD_HASH?.trim() || ''
  if (hash) return hash
  const password = process.env.APP_ADMIN_PASSWORD?.trim() || ''
  if (!password) return ''
  if (password.length < 12) {
    console.warn('[open-bugster] APP_ADMIN_PASSWORD has fewer than 12 characters and was ignored. Choose a longer password and restart.')
    return ''
  }
  return hashStoredPassword(password)
}

/**
 * The bootstrap identity, read once on first start to seed the owner account. After that
 * the `users` table is the only source of truth and these variables are ignored.
 */
function configuredOwnerSeed(): OwnerSeed | null {
  const passwordHash = configuredOwnerPasswordHash()
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
 * How many rows can actually sign in. Contacts share the table with accounts, so a bare
 * `COUNT(*)` would read an imported TestFlight tester as a provisioned instance and skip
 * seeding the owner. Tolerates the pre-`kind` shape, since this runs mid-migration.
 */
function countAccountRows(db: Database.Database): number {
  const scoped = tableColumns(db, 'users').has('kind') ? " WHERE kind = 'account'" : ''
  return (db.prepare(`SELECT COUNT(*) AS value FROM users${scoped}`).get() as { value: number }).value
}

/**
 * A first start without a bootstrap credential seeds no owner, and the login page then
 * rejects every attempt with the same deliberately vague message. Say so on the console
 * rather than leaving the operator to guess why their password does not work.
 */
function warnWhenNobodyCanSignIn(db: Database.Database) {
  if (countAccountRows(db) > 0) return
  console.warn('[open-bugster] No account exists yet, so nobody can sign in: neither APP_ADMIN_PASSWORD nor APP_PASSWORD_HASH is set.')
  console.warn('[open-bugster] Set APP_ADMIN_EMAIL and APP_ADMIN_PASSWORD (12+ characters) in .env or the environment, then restart.')
}

/**
 * Everybody in `users`, by id. `hydrateTicket` runs once per row, so reading a person per
 * ticket would add an N+1 on top of the sub-queries it already makes; every write to
 * `users` drops the cache instead.
 */
let directoryCache: Map<string, Person> | null = null

function personDirectory(): Map<string, Person> {
  if (directoryCache) return directoryCache
  const rows = getDb().prepare('SELECT id, email, first_name, last_name, kind, status, anonymized_at FROM users').all() as Array<{
    id: string; email: string | null; first_name: string; last_name: string; kind: UserKind; status: UserStatus | null; anonymized_at: string | null
  }>
  directoryCache = new Map(rows.map(row => [row.id, {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    isAccount: row.kind === 'account',
    isService: row.kind === 'service',
    status: row.status,
    anonymizedAt: row.anonymized_at,
  }]))
  return directoryCache
}

export function invalidateUserDirectory() {
  directoryCache = null
}

/**
 * The person a stored id points at. Null only where the column itself is null — a ticket
 * whose person was hard-deleted, or an entry that never had one.
 */
export function personById(id: string | null | undefined): Person | null {
  return id ? personDirectory().get(id) || null : null
}

/** The id an address belongs to, creating a contact row when nobody holds it yet. */
export function upsertContactByEmail(email: string, name?: { firstName?: string | null; lastName?: string | null }): string {
  const normalised = email.trim().toLowerCase()
  const existing = getDb().prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(normalised) as { id: string } | undefined
  if (existing) return existing.id
  const id = randomUUID()
  getDb().prepare(`
    INSERT INTO users (id, email, first_name, last_name, kind, role, status, created_at)
    VALUES (?, ?, ?, ?, 'contact', 'member', NULL, ?)
  `).run(id, normalised, name?.firstName || '', name?.lastName || '', new Date().toISOString())
  invalidateUserDirectory()
  return id
}

/** The activity payload keys whose value is a person id rather than a plain value. */
const personPayloadKeys: Partial<Record<ActivityKind, string[]>> = {
  assigned: ['from', 'to'],
  unassigned: ['from', 'to'],
  author: ['from', 'to'],
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

/**
 * The same stop sign for the migrations that predate `ensurePersonIdentity`. Those add the
 * very email columns it replaces with user ids, so on a converted database — including
 * every fresh one, which `schema` already creates in the target shape — they must not run.
 */
function alreadyOnPersonIds(db: Database.Database): boolean {
  return tableColumns(db, 'tickets').has('author_id')
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
  if (alreadyOnPersonIds(db)) return false
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

  const populated = countAccountRows(db) > 0
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
  if (alreadyOnPersonIds(db)) return false
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

/**
 * Adds the per-board switch that decides whether an import attributes its ticket to the
 * tester's account. On by default: attributing is what people expect from a board whose
 * testers are colleagues, and a board that would rather keep imports anonymous turns it off.
 */
export function ensureBoardAutoAuthor(db: Database.Database) {
  if (tableColumns(db, 'boards').has('auto_author')) return false
  db.exec('ALTER TABLE boards ADD COLUMN auto_author INTEGER NOT NULL DEFAULT 1')
  return true
}

/**
 * Adds the line shown under the board title. Empty rather than null, so every board has a
 * description and the UI only has to ask whether it is blank.
 */
/**
 * The type a board's TestFlight imports land with. Nullable: gone with the type itself.
 * Every board starts on its workspace's "Ticket" type — on upgrade day the existing boards
 * are pointed at it once, the same way `createBoard` does for a new one.
 */
export function ensureBoardImportType(db: Database.Database) {
  if (tableColumns(db, 'boards').has('import_type_id')) return false
  db.exec('ALTER TABLE boards ADD COLUMN import_type_id TEXT REFERENCES ticket_types(id) ON DELETE SET NULL')
  db.prepare(`UPDATE boards SET import_type_id = (${DEFAULT_IMPORT_TYPE_SQL}) WHERE import_type_id IS NULL`).run()
  return true
}

/** The "Ticket" type of a board's workspace, or NULL where the workspace has none. */
const DEFAULT_IMPORT_TYPE_SQL = `
  SELECT tt.id FROM ticket_types tt
  WHERE tt.workspace_id = boards.workspace_id AND tt.name = '${DEFAULT_IMPORT_TYPE_NAME}' COLLATE NOCASE
  ORDER BY tt.position LIMIT 1
`

export function ensureBoardDescription(db: Database.Database) {
  if (tableColumns(db, 'boards').has('description')) return false
  db.exec(`ALTER TABLE boards ADD COLUMN description TEXT NOT NULL DEFAULT ''`)
  return true
}

/** The email columns `ensurePersonIdentity` replaces, as `[table, column]`. */
const legacyPersonColumns: Array<[string, string]> = [
  ['tickets', 'author_email'],
  ['tickets', 'assignee_email'],
  ['ticket_comments', 'author_email'],
  ['ticket_activity', 'actor_email'],
  ['apple_feedback', 'tester_email'],
]

/**
 * Rebuilds `users` so that everybody a ticket can point at has a row, not just the people
 * who can sign in. Existing rows become `account`; `kind = 'contact'` is everyone else.
 *
 * `email` and `status` lose their NOT NULL along the way, which is what makes anonymizing
 * possible at all — a scrubbed row keeps its id and its history, and gives up the address.
 */
function rebuildUsersWithKind(db: Database.Database) {
  db.pragma('foreign_keys = OFF')
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE users_migration (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE COLLATE NOCASE,
        first_name TEXT NOT NULL DEFAULT '',
        last_name TEXT NOT NULL DEFAULT '',
        password_hash TEXT,
        kind TEXT NOT NULL DEFAULT 'account' CHECK (kind IN ('account', 'contact')),
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
        status TEXT CHECK (status IS NULL OR status IN ('invited', 'active', 'disabled')),
        session_version INTEGER NOT NULL DEFAULT 1,
        invite_token_hash TEXT,
        invite_expires_at TEXT,
        anonymized_at TEXT,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );
      INSERT INTO users_migration (id, email, first_name, last_name, password_hash, kind, role, status, session_version, invite_token_hash, invite_expires_at, created_at, last_login_at)
      SELECT id, email, first_name, last_name, password_hash, 'account', role, status, session_version, invite_token_hash, invite_expires_at, created_at, last_login_at
      FROM users;
      DROP TABLE users;
      ALTER TABLE users_migration RENAME TO users;
      COMMIT;
    `)
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw error
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

/**
 * Gives every address that appears anywhere in the history a row of its own. The name
 * snapshot the tickets carried is the only name these people have, so it moves with them —
 * and then stops being a second copy that anonymizing would miss.
 */
function seedContactsFromEmails(db: Database.Database) {
  // The author columns lead the union so that it names the result columns; `MAX` then skips
  // the NULLs the other sources contribute and keeps whichever snapshot exists.
  const sources = legacyPersonColumns
    .map(([table, column]) => {
      const names = column === 'author_email' && table === 'tickets'
        ? 'author_first_name AS first_name, author_last_name AS last_name'
        : 'NULL AS first_name, NULL AS last_name'
      return `SELECT ${column} AS email, ${names} FROM ${table} WHERE TRIM(COALESCE(${column}, '')) <> ''`
    })
    .join(' UNION ALL ')

  const rows = db.prepare(`
    SELECT LOWER(TRIM(email)) AS email, MAX(first_name) AS first_name, MAX(last_name) AS last_name
    FROM (${sources})
    GROUP BY LOWER(TRIM(email))
  `).all() as Array<{ email: string; first_name: string | null; last_name: string | null }>

  const payloadEmails = activityPayloadEmails(db)
  for (const email of payloadEmails) {
    if (!rows.some(row => row.email === email)) rows.push({ email, first_name: null, last_name: null })
  }

  const now = new Date().toISOString()
  const insert = db.prepare(`
    INSERT INTO users (id, email, first_name, last_name, kind, role, status, created_at)
    SELECT ?, ?, ?, ?, 'contact', 'member', NULL, ?
    WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ? COLLATE NOCASE)
  `)
  db.transaction(() => {
    for (const row of rows) {
      insert.run(randomUUID(), row.email, row.first_name || '', row.last_name || '', now, row.email)
    }
  })()
}

/** Every address buried in an activity payload, which the column scan above cannot see. */
function activityPayloadEmails(db: Database.Database): string[] {
  const rows = db.prepare('SELECT kind, payload FROM ticket_activity').all() as Array<{ kind: ActivityKind; payload: string }>
  const found = new Set<string>()
  for (const row of rows) {
    for (const key of personPayloadKeys[row.kind] || []) {
      const value = safeJson(row.payload)[key]
      if (value && value.includes('@')) found.add(value.trim().toLowerCase())
    }
  }
  return [...found]
}

/**
 * An assignment entry recorded who it named as a raw address, so anonymizing an account
 * would leave it named in its own history. Swap those for ids while the mapping is still
 * a plain email lookup.
 */
function rewriteActivityPayloadToIds(db: Database.Database) {
  const byEmail = new Map((db.prepare('SELECT id, email FROM users').all() as Array<{ id: string; email: string | null }>)
    .filter(row => row.email)
    .map(row => [row.email!.trim().toLowerCase(), row.id]))
  const rows = db.prepare('SELECT id, kind, payload FROM ticket_activity').all() as Array<{ id: string; kind: ActivityKind; payload: string }>
  const update = db.prepare('UPDATE ticket_activity SET payload = ? WHERE id = ?')
  db.transaction(() => {
    for (const row of rows) {
      const keys = personPayloadKeys[row.kind]
      if (!keys) continue
      const payload = safeJson(row.payload)
      let touched = false
      for (const key of keys) {
        const value = payload[key]
        if (!value || !value.includes('@')) continue
        payload[key] = byEmail.get(value.trim().toLowerCase()) || null
        touched = true
      }
      if (touched) update.run(JSON.stringify(payload), row.id)
    }
  })()
}

/** Swaps the email column on every table that names a person for a real foreign key. */
function rebuildPersonColumns(db: Database.Database) {
  db.pragma('foreign_keys = OFF')
  try {
    db.exec(`
      BEGIN IMMEDIATE;

      CREATE TABLE tickets_migration (
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
        author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        category_id TEXT REFERENCES categories(id) ON DELETE SET NULL
      );
      INSERT INTO tickets_migration (id, ticket_number, board_id, lane_id, title, description, position, priority, due_date, build_number, source, external_id, created_at, updated_at, archived_at, author_id, assignee_id, category_id)
      SELECT t.id, t.ticket_number, t.board_id, t.lane_id, t.title, t.description, t.position, t.priority, t.due_date, t.build_number,
             t.source, t.external_id, t.created_at, t.updated_at, t.archived_at, author.id, assignee.id, t.category_id
      FROM tickets t
      LEFT JOIN users author ON author.email = TRIM(t.author_email)
      LEFT JOIN users assignee ON assignee.email = TRIM(t.assignee_email);
      DROP TABLE tickets;
      ALTER TABLE tickets_migration RENAME TO tickets;

      CREATE TABLE ticket_comments_migration (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO ticket_comments_migration (id, ticket_id, author_id, body, created_at, updated_at)
      SELECT c.id, c.ticket_id, author.id, c.body, c.created_at, c.updated_at
      FROM ticket_comments c
      LEFT JOIN users author ON author.email = TRIM(c.author_email);
      DROP TABLE ticket_comments;
      ALTER TABLE ticket_comments_migration RENAME TO ticket_comments;

      CREATE TABLE ticket_activity_migration (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO ticket_activity_migration (id, ticket_id, actor_id, kind, payload, created_at)
      SELECT a.id, a.ticket_id, actor.id, a.kind, a.payload, a.created_at
      FROM ticket_activity a
      LEFT JOIN users actor ON actor.email = TRIM(a.actor_email);
      DROP TABLE ticket_activity;
      ALTER TABLE ticket_activity_migration RENAME TO ticket_activity;

      CREATE TABLE apple_feedback_migration (
        ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
        feedback_type TEXT NOT NULL CHECK (feedback_type IN ('screenshot', 'crash')),
        comment TEXT,
        tester_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        device_model TEXT,
        os_version TEXT,
        locale TEXT,
        build_id TEXT,
        build_version TEXT,
        build_bundle_id TEXT,
        source_created_at TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );
      INSERT INTO apple_feedback_migration (ticket_id, feedback_type, comment, tester_id, device_model, os_version, locale, build_id, build_version, build_bundle_id, source_created_at, raw_json)
      SELECT f.ticket_id, f.feedback_type, f.comment, tester.id, f.device_model, f.os_version, f.locale, f.build_id, f.build_version, f.build_bundle_id, f.source_created_at, f.raw_json
      FROM apple_feedback f
      LEFT JOIN users tester ON tester.email = TRIM(f.tester_email);
      DROP TABLE apple_feedback;
      ALTER TABLE apple_feedback_migration RENAME TO apple_feedback;

      COMMIT;
    `)
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw error
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

/**
 * Replaces every stored email address with a user id.
 *
 * Everybody a ticket, comment, activity entry or TestFlight import names gets a row in
 * `users` — accounts as before, everyone else as a `contact`. Pointing at people by id is
 * what finally makes a person editable: an address can change and an account can be
 * anonymized without rewriting a single row of the history that refers to them.
 *
 * Has to run last. Every migration above it still speaks in email columns.
 */
export function ensurePersonIdentity(db: Database.Database) {
  if (alreadyOnPersonIds(db)) return false

  rebuildUsersWithKind(db)
  seedContactsFromEmails(db)
  rewriteActivityPayloadToIds(db)
  rebuildPersonColumns(db)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket ON ticket_comments(ticket_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ticket_activity_ticket ON ticket_activity(ticket_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON apple_feedback(source_created_at);
  `)

  // The import rule, applied to what was imported before it existed. Every board starts with
  // the switch on, so a board that opts out afterwards keeps the authors it already gained.
  db.prepare(`
    UPDATE tickets SET author_id = (
      SELECT f.tester_id FROM apple_feedback f
      JOIN users u ON u.id = f.tester_id AND u.kind = 'account'
      WHERE f.ticket_id = tickets.id
    )
    WHERE source IN ('testflight_screenshot', 'testflight_crash') AND author_id IS NULL
  `).run()

  const foreignKeyErrors = db.pragma('foreign_key_check') as unknown[]
  if (foreignKeyErrors.length) throw new Error('The SQLite migration created invalid foreign keys.')
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

/*
 * Everything below runs *after* `ensurePersonIdentity` and speaks in person ids from the
 * start. Nothing here may reintroduce an email column: the whole point of that migration is
 * that a person can be renamed, re-addressed or anonymized without rewriting history.
 */

/**
 * Records how a change arrived, not just who is behind it.
 *
 * `actor_id` already answers who is responsible. These two answer what performed the change
 * and over which surface, so a ticket's history can say "moved by Markus via Claude" instead
 * of quietly attributing an agent's work to a person who was not at the keyboard.
 *
 * Existing rows default to `web`, which is true of every entry written before agents existed.
 */
export function ensureActorContext(db: Database.Database) {
  const columns = tableColumns(db, 'ticket_activity')
  if (columns.has('channel')) return false
  db.exec(`
    ALTER TABLE ticket_activity ADD COLUMN agent_id TEXT;
    ALTER TABLE ticket_activity ADD COLUMN channel TEXT NOT NULL DEFAULT 'web';
  `)
  return true
}

/**
 * The audit trail, which is a different thing from a ticket's timeline and deliberately not
 * the same table.
 *
 * `ticket_activity` is written for people to read on a ticket, and dies with that ticket —
 * its cascade is correct there and disqualifying here. This one is append-only, survives the
 * deletion of whatever it describes, and covers what a ticket-scoped table structurally
 * cannot: a board removed, a role changed, a key uploaded, a token minted, a sign-in refused.
 *
 * `board_id` carries no foreign key on purpose, so an entry outlives the board it names.
 * Everything else that identifies a person is an id, never a name or an address, which is
 * what lets `anonymizeUser` empty this log of identifying data without touching a row.
 */
export function ensureAuditLog(db: Database.Database) {
  const existed = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'audit_log'").get())
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      board_id TEXT,
      principal_id TEXT,
      agent_id TEXT,
      token_id TEXT,
      channel TEXT NOT NULL DEFAULT 'web',
      operation TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      changes TEXT NOT NULL DEFAULT '{}',
      result TEXT NOT NULL DEFAULT 'ok',
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_board ON audit_log(board_id, at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_principal ON audit_log(principal_id, at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_operation ON audit_log(operation, at DESC);
  `)
  return !existed
}

/**
 * Widens `users.kind` to admit a third kind of person: a machine.
 *
 * A service identity is a first-class principal — it holds board memberships and roles like
 * anyone, shows up in the history as itself rather than as somebody it borrowed, and can be
 * disabled the same way. What it does not have is a password or a session; it acts only
 * through a token.
 *
 * SQLite cannot widen a CHECK constraint, so the table is rebuilt. `idx_users_kind` goes with
 * the old table and comes back when `personIndexes` runs a few lines later in `getDb`.
 */
export function ensureServiceIdentities(db: Database.Database) {
  const current = (db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'users'").get() as { sql: string } | undefined)?.sql || ''
  if (current.includes("'service'")) return false

  db.pragma('foreign_keys = OFF')
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE users_service_migration (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE COLLATE NOCASE,
        first_name TEXT NOT NULL DEFAULT '',
        last_name TEXT NOT NULL DEFAULT '',
        password_hash TEXT,
        kind TEXT NOT NULL DEFAULT 'account' CHECK (kind IN ('account', 'contact', 'service')),
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
        status TEXT CHECK (status IS NULL OR status IN ('invited', 'active', 'disabled')),
        session_version INTEGER NOT NULL DEFAULT 1,
        invite_token_hash TEXT,
        invite_expires_at TEXT,
        anonymized_at TEXT,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );
      INSERT INTO users_service_migration
        SELECT id, email, first_name, last_name, password_hash, kind, role, status, session_version,
               invite_token_hash, invite_expires_at, anonymized_at, created_at, last_login_at
        FROM users;
      DROP TABLE users;
      ALTER TABLE users_service_migration RENAME TO users;
      COMMIT;
    `)
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw error
  } finally {
    db.pragma('foreign_keys = ON')
  }
  return true
}

/**
 * The credentials a non-browser caller presents.
 *
 * Only a hash is stored, so a copy of the database hands out no working tokens. `scopes` and
 * `board_id` are a ceiling on what the credential may do, never a grant: what a token can
 * reach is always the intersection of its scopes with what its principal could already do.
 */
export function ensureApiTokens(db: Database.Database) {
  const existed = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'api_tokens'").get())
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      agent_label TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL DEFAULT '["read"]',
      board_id TEXT REFERENCES boards(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      created_by TEXT,
      expires_at TEXT,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_tokens_principal ON api_tokens(principal_id, revoked_at);
  `)
  return !existed
}

/**
 * Replayed responses for `Idempotency-Key`.
 *
 * n8n and every other workflow tool retries. Without this, a retried `POST /tickets` after a
 * timeout files the ticket twice — and the caller cannot tell, because the response it never
 * received is the only place the first id appeared.
 *
 * The request fingerprint is stored alongside, so reusing one key for a different request is
 * a 409 rather than a silently wrong replay.
 */
export function ensureIdempotencyKeys(db: Database.Database) {
  const existed = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'idempotency_keys'").get())
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status INTEGER NOT NULL,
      body TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (key, principal_id)
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
  `)
  return !existed
}

export interface IdempotentRecord {
  fingerprint: string
  status: number
  body: string | null
}

export function findIdempotent(key: string, principalId: string): IdempotentRecord | null {
  const row = getDb().prepare('SELECT fingerprint, status, body FROM idempotency_keys WHERE key = ? AND principal_id = ?')
    .get(key, principalId) as IdempotentRecord | undefined
  return row ?? null
}

export function saveIdempotent(key: string, principalId: string, record: IdempotentRecord) {
  getDb().prepare(`
    INSERT INTO idempotency_keys (key, principal_id, fingerprint, status, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (key, principal_id) DO NOTHING
  `).run(key, principalId, record.fingerprint, record.status, record.body, new Date().toISOString())
}

/** Keys are only useful for as long as a client might still retry. */
export function pruneIdempotent(hours = 24): number {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString()
  return getDb().prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff).changes
}

/**
 * Where a board sends its events, and what happened when it tried.
 *
 * Board-scoped rather than instance-wide: a webhook spends the trust of the board whose
 * tickets it describes, and a board admin should be able to wire up their own without being
 * handed every other board's activity.
 *
 * The secret is stored in the clear on purpose — unlike a password or a token, the server has
 * to reproduce it to sign each delivery, so there is nothing a hash could be checked against.
 * It is generated here rather than supplied, so it is always long enough to matter.
 */
/**
 * Adds the per-membership automation permission.
 *
 * Existing memberships are granted it, because on an instance that is already running an
 * agent or a script, an upgrade that silently starts refusing them would look like an
 * outage. New memberships default to off: it is a permission a board admin gives out.
 */
export function ensureBoardMemberAutomation(db: Database.Database) {
  if (tableColumns(db, 'board_members').has('may_automate')) return false
  db.exec('ALTER TABLE board_members ADD COLUMN may_automate INTEGER NOT NULL DEFAULT 0')
  db.exec('UPDATE board_members SET may_automate = 1')
  return true
}

/**
 * Adds the level above boards.
 *
 * `boards.workspace_id` has no NOT NULL because SQLite cannot add one without a constant
 * default; the adoption below is what makes it always set in practice, and it doubles as
 * the safety net for any row that ever ends up without one.
 *
 * Runs its statements every start on purpose: an instance always keeps at least one
 * workspace, so a fresh database gets its first one here, under the same name an upgraded
 * one gets — the upgrade is invisible until somebody creates a second.
 */
export function ensureWorkspaces(db: Database.Database) {
  const migrated = !tableColumns(db, 'boards').has('workspace_id')
  if (migrated) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
        added_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      );
      ALTER TABLE boards ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
    `)
  }
  const count = (db.prepare('SELECT COUNT(*) AS value FROM workspaces').get() as { value: number }).value
  if (count === 0) {
    db.prepare('INSERT INTO workspaces (id, name, position, created_at) VALUES (?, ?, 0, ?)')
      .run(randomUUID(), DEFAULT_WORKSPACE_NAME, new Date().toISOString())
  }
  db.prepare('UPDATE boards SET workspace_id = (SELECT id FROM workspaces ORDER BY position, created_at LIMIT 1) WHERE workspace_id IS NULL').run()
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_boards_workspace ON boards(workspace_id, position);
    CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);
  `)
  return migrated
}

/**
 * Adds the line shown next to the workspace name in the header. Empty rather than null,
 * for the same reason as the board description: the UI only asks whether it is blank.
 */
export function ensureWorkspaceDescription(db: Database.Database) {
  if (tableColumns(db, 'workspaces').has('description')) return false
  db.exec(`ALTER TABLE workspaces ADD COLUMN description TEXT NOT NULL DEFAULT ''`)
  return true
}

/**
 * Ticket types: a workspace-owned vocabulary for what kind of thing a ticket is, and a
 * nullable pointer from each ticket. Mirrors `ensureWorkspaces`: the column on `tickets` is
 * what tells an upgrading database from one that has been here before, and every workspace
 * that exists at that moment gets the default set once — never again, so a workspace that
 * deletes "Todo" does not find it back after a restart.
 */
export function ensureTicketTypes(db: Database.Database) {
  const migrated = !tableColumns(db, 'tickets').has('type_id')
  if (migrated) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_types (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        color TEXT NOT NULL DEFAULT 'neutral',
        icon_kind TEXT NOT NULL CHECK (icon_kind IN ('lucide', 'image')),
        icon_value TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      ALTER TABLE tickets ADD COLUMN type_id TEXT REFERENCES ticket_types(id) ON DELETE SET NULL;
    `)
    for (const { id } of db.prepare('SELECT id FROM workspaces').all() as Array<{ id: string }>) seedDefaultTicketTypes(db, id)
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_types_workspace_name ON ticket_types(workspace_id, name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_ticket_types_workspace ON ticket_types(workspace_id, position);
    CREATE INDEX IF NOT EXISTS idx_tickets_type ON tickets(type_id);
  `)
  return migrated
}

function seedDefaultTicketTypes(db: Database.Database, workspaceId: string) {
  const insert = db.prepare('INSERT INTO ticket_types (id, workspace_id, name, color, icon_kind, icon_value, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  const now = new Date().toISOString()
  DEFAULT_TICKET_TYPES.forEach((type, position) => {
    const [kind, value] = iconColumns(type.icon)
    insert.run(randomUUID(), workspaceId, type.name, type.color, kind, value, position, now)
  })
}

export function ensureWebhooks(db: Database.Database) {
  const existed = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'webhooks'").get())
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT,
      /* Set when deliveries have failed for long enough that nobody is listening. */
      disabled_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_delivery_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_board ON webhooks(board_id, enabled);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
      event TEXT NOT NULL,
      at TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      status INTEGER,
      error TEXT,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries ON webhook_deliveries(webhook_id, at DESC);
  `)
  return !existed
}

type BoardRow = {
  id: string; name: string; description: string; position: number
  asc_issuer_id: string; asc_key_id: string; asc_app_id: string
  asc_private_key: string | null; asc_key_filename: string | null; asc_key_uploaded_at: string | null
  sync_limit: number; auto_author: number; import_type_id: string | null; created_at: string
  // Nullable in the column (SQLite cannot add NOT NULL after the fact), never null in
  // practice: `ensureWorkspaces` adopts every orphan on start.
  workspace_id: string
}

type WorkspaceRow = { id: string; name: string; description: string; position: number; created_at: string }

type LaneRow = { id: string; board_id: string; name: string; position: number; is_import: number }

type TicketRow = {
  id: string; ticket_number: number; board_id: string; lane_id: string; title: string; description: string
  position: number; priority: TicketPriority; due_date: string | null; build_number: string | null
  source: TicketSource; external_id: string | null; created_at: string; updated_at: string; archived_at: string | null
  category_id: string | null; author_id: string | null; assignee_id: string | null; type_id: string | null
}

type TicketTypeRow = {
  id: string; workspace_id: string; name: string; color: TicketTypeColor
  icon_kind: TicketTypeIcon['kind']; icon_value: string; position: number; created_at: string
}

function toTicketType(row: TicketTypeRow): TicketType {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    color: row.color,
    icon: row.icon_kind === 'image' ? { kind: 'image', dataUrl: row.icon_value } : { kind: 'lucide', name: row.icon_value as TicketTypeIconName },
    position: row.position,
    createdAt: row.created_at
  }
}

/** What a ticket carries of its type — everything but the image bytes. */
function toTicketTypeRef(type: TicketType): TicketTypeRef {
  return { id: type.id, name: type.name, color: type.color, icon: type.icon.kind === 'image' ? { kind: 'image' } : type.icon }
}

function iconColumns(icon: TicketTypeIcon): [TicketTypeIcon['kind'], string] {
  return icon.kind === 'image' ? ['image', icon.dataUrl] : ['lucide', icon.name]
}

function toBoard(row: BoardRow): Board {
  return { id: row.id, workspaceId: row.workspace_id, name: row.name, description: row.description, position: row.position, syncLimit: row.sync_limit, autoAuthor: Boolean(row.auto_author), importTypeId: row.import_type_id ?? null, createdAt: row.created_at }
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
  const rows = getDb().prepare(`
    SELECT u.id AS userId, u.email, u.first_name AS firstName, u.last_name AS lastName, u.status,
           m.role, m.may_automate AS mayAutomate, m.added_at AS addedAt
    FROM board_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.board_id = ?
    ORDER BY u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE, u.email COLLATE NOCASE
  `).all(boardId) as Array<Omit<BoardMember, 'mayAutomate'> & { mayAutomate: number }>
  // SQLite has no boolean, so the flag arrives as 0 or 1 and is mapped rather than cast.
  // A board administrator always holds it: they may hand it to anybody, themselves included,
  // so withholding it from them would be a lock with the key beside it. The stored value is
  // left untouched, so demoting somebody to editor brings back whatever they were given.
  return rows.map(row => ({ ...row, mayAutomate: row.role === 'admin' || Boolean(row.mayAutomate) }))
}

/**
 * Whether somebody may work this board through a token rather than the browser.
 *
 * Absent membership reads as false; the caller has already decided what a non-member is told.
 */
export function boardAutomationAllowed(boardId: string, userId: string): boolean {
  const row = getDb().prepare('SELECT role, may_automate FROM board_members WHERE board_id = ? AND user_id = ?')
    .get(boardId, userId) as { role: BoardRole; may_automate: number } | undefined
  if (!row) return false
  return row.role === 'admin' || Boolean(row.may_automate)
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return { id: row.id, name: row.name, description: row.description, position: row.position, createdAt: row.created_at }
}

export function workspaceMembers(workspaceId: string): WorkspaceMember[] {
  return getDb().prepare(`
    SELECT u.id AS userId, u.email, u.first_name AS firstName, u.last_name AS lastName, u.status,
           m.role, m.added_at AS addedAt
    FROM workspace_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ?
    ORDER BY u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE, u.email COLLATE NOCASE
  `).all(workspaceId) as WorkspaceMember[]
}

/** The explicit role somebody holds on a workspace, or null when they hold none. */
export function workspaceRoleFor(workspaceId: string, userId: string): WorkspaceRole | null {
  const row = getDb().prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId) as { role: WorkspaceRole } | undefined
  return row?.role || null
}

/** Whether one of the workspace's boards lets this user in, membership row or not. */
export function workspaceReachableThroughBoards(workspaceId: string, userId: string): boolean {
  return Boolean(getDb().prepare(`
    SELECT 1 FROM boards b
    JOIN board_members m ON m.board_id = b.id AND m.user_id = ?
    WHERE b.workspace_id = ?
    LIMIT 1
  `).get(userId, workspaceId))
}

function toWorkspaceSummary(row: WorkspaceRow, viewer?: BoardViewer | null): WorkspaceSummary {
  return {
    ...toWorkspace(row),
    members: workspaceMembers(row.id),
    boardCount: (getDb().prepare('SELECT COUNT(*) AS value FROM boards WHERE workspace_id = ?').get(row.id) as { value: number }).value,
    // Same rule as the board summary: an instance admin — or an internal call — holds every
    // workspace. Everybody else gets their explicit role, or null for board-derived visibility.
    role: !viewer || viewer.instanceAdmin ? 'admin' : workspaceRoleFor(row.id, viewer.userId)
  }
}

export function listWorkspaces(viewer?: BoardViewer | null): WorkspaceSummary[] {
  const db = getDb()
  const scoped = viewer && !viewer.instanceAdmin
  const rows = (scoped
    ? db.prepare(`
        SELECT DISTINCT w.* FROM workspaces w
        LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = ?
        LEFT JOIN boards b ON b.workspace_id = w.id
        LEFT JOIN board_members bm ON bm.board_id = b.id AND bm.user_id = ?
        WHERE wm.user_id IS NOT NULL OR bm.user_id IS NOT NULL
        ORDER BY w.position, w.created_at
      `).all(viewer.userId, viewer.userId)
    : db.prepare('SELECT * FROM workspaces ORDER BY position, created_at').all()) as WorkspaceRow[]
  return rows.map(row => toWorkspaceSummary(row, viewer))
}

export function findWorkspace(id: string): Workspace | null {
  const row = getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined
  return row ? toWorkspace(row) : null
}

export function findWorkspaceSummary(id: string, viewer?: BoardViewer | null): WorkspaceSummary | null {
  const row = getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined
  return row ? toWorkspaceSummary(row, viewer) : null
}

export function countWorkspaces(): number {
  return (getDb().prepare('SELECT COUNT(*) AS value FROM workspaces').get() as { value: number }).value
}

export function countWorkspaceBoards(workspaceId: string): number {
  return (getDb().prepare('SELECT COUNT(*) AS value FROM boards WHERE workspace_id = ?').get(workspaceId) as { value: number }).value
}

/** Where a board lands when nobody named a workspace: the first one, by position. */
export function defaultWorkspaceId(): string {
  return (getDb().prepare('SELECT id FROM workspaces ORDER BY position, created_at LIMIT 1').get() as { id: string }).id
}

export function createWorkspace(name: string, creatorId: string | null = null): WorkspaceSummary {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM workspaces').get() as { position: number }).position
  db.transaction(() => {
    db.prepare('INSERT INTO workspaces (id, name, position, created_at) VALUES (?, ?, ?, ?)').run(id, name, position, now)
    // The creator is an instance admin today, but an explicit row keeps their hold on the
    // workspace even if that instance role is ever taken away — same move as `createBoard`.
    if (creatorId) {
      db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES (?, ?, 'admin', ?)").run(id, creatorId, now)
    }
    seedDefaultTicketTypes(db, id)
  })()
  return findWorkspaceSummary(id, creatorId ? { userId: creatorId, instanceAdmin: false } : null)!
}

export function updateWorkspace(id: string, input: { name?: string; description?: string }, viewer?: BoardViewer | null): WorkspaceSummary | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined
  if (!row) return null
  // `??` keeps an omitted field as it was, while an empty string really clears it.
  db.prepare('UPDATE workspaces SET name = ?, description = ? WHERE id = ?')
    .run(input.name ?? row.name, input.description ?? row.description, id)
  return findWorkspaceSummary(id, viewer)
}

/** The guards — no boards left behind, never the last workspace — belong to the operation. */
export function deleteWorkspace(id: string): boolean {
  return getDb().prepare('DELETE FROM workspaces WHERE id = ?').run(id).changes > 0
}

/** Takes any principal, like `setBoardMember`: a service identity may hold a workspace role. */
export function setWorkspaceMember(workspaceId: string, userId: string, role: WorkspaceRole): WorkspaceMember | null {
  if (!findWorkspace(workspaceId) || !findPrincipal(userId)) return null
  getDb().prepare(`
    INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role
  `).run(workspaceId, userId, role, new Date().toISOString())
  return workspaceMembers(workspaceId).find(member => member.userId === userId) || null
}

export function removeWorkspaceMember(workspaceId: string, userId: string): boolean {
  return getDb().prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(workspaceId, userId).changes > 0
}

/** Re-homes a board. Membership travels with it, so nobody gains or loses any access. */
export function moveBoardToWorkspace(boardId: string, workspaceId: string, viewer?: BoardViewer | null): BoardSummary | null {
  const db = getDb()
  if (!findBoard(boardId) || !findWorkspace(workspaceId)) return null
  db.transaction(() => {
    const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM boards WHERE workspace_id = ?').get(workspaceId) as { position: number }).position
    db.prepare('UPDATE boards SET workspace_id = ?, position = ? WHERE id = ?').run(workspaceId, position, boardId)
    retargetTicketTypes(db, boardId, workspaceId)
    retargetImportType(db, boardId, workspaceId)
  })()
  return findBoardSummary(boardId, viewer)
}

/** The board's own import type follows the same rule as its tickets' types. */
function retargetImportType(db: Database.Database, boardId: string, workspaceId: string) {
  db.prepare(`
    UPDATE boards SET import_type_id = (
      SELECT target.id FROM ticket_types target
      JOIN ticket_types source ON source.name = target.name COLLATE NOCASE
      WHERE source.id = boards.import_type_id AND target.workspace_id = ?
    )
    WHERE id = ? AND import_type_id IS NOT NULL
  `).run(workspaceId, boardId)
}

/**
 * Points a board's tickets at the types of the workspace it now lives in, matched by name;
 * a type the new workspace does not know becomes "no type". Types belong to a workspace, so
 * a ticket must never keep naming one from a workspace its board has left.
 */
function retargetTicketTypes(db: Database.Database, boardId: string, workspaceId: string) {
  db.prepare(`
    UPDATE tickets SET type_id = (
      SELECT target.id FROM ticket_types target
      JOIN ticket_types source ON source.name = target.name COLLATE NOCASE
      WHERE source.id = tickets.type_id AND target.workspace_id = ?
    )
    WHERE board_id = ? AND type_id IS NOT NULL
  `).run(workspaceId, boardId)
}

export interface BoardDuplicateOptions {
  name: string
  workspaceId: string
  /** Off copies the structure — lanes, categories, labels, members — and nothing on it. */
  includeTickets: boolean
  creatorId: string | null
}

/** A file the caller still has to copy on disk; both paths are attachment-root-relative. */
export interface AttachmentCopy {
  from: string
  to: string
}

/**
 * Copies a board.
 *
 * Deliberately not copied, ever: the App Store Connect credentials (two boards spending one
 * Apple key would import every submission twice, and the key is the board's own), webhooks
 * (their secrets and receivers belong to the original), comments, activity, sync history and
 * audit entries (history stays where it happened).
 *
 * Attachment rows are written here, pointing at fresh paths; the bytes are copied by the
 * caller afterwards, because this transaction is synchronous and the filesystem is not.
 */
export function duplicateBoard(sourceId: string, options: BoardDuplicateOptions): { board: BoardSummary; attachmentCopies: AttachmentCopy[] } | null {
  const db = getDb()
  const source = db.prepare('SELECT * FROM boards WHERE id = ?').get(sourceId) as BoardRow | undefined
  if (!source || !findWorkspace(options.workspaceId)) return null
  const id = randomUUID()
  const now = new Date().toISOString()
  const attachmentCopies: AttachmentCopy[] = []
  db.transaction(() => {
    const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM boards WHERE workspace_id = ?').get(options.workspaceId) as { position: number }).position
    db.prepare('INSERT INTO boards (id, workspace_id, name, description, position, sync_limit, auto_author, import_type_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, options.workspaceId, options.name, source.description, position, source.sync_limit, source.auto_author, source.import_type_id ?? null, now)
    if (options.workspaceId !== source.workspace_id) retargetImportType(db, id, options.workspaceId)

    const laneIds = new Map<string, string>()
    for (const lane of db.prepare('SELECT * FROM lanes WHERE board_id = ? ORDER BY position').all(sourceId) as LaneRow[]) {
      const laneId = randomUUID()
      laneIds.set(lane.id, laneId)
      db.prepare('INSERT INTO lanes (id, board_id, name, position, is_import) VALUES (?, ?, ?, ?, ?)').run(laneId, id, lane.name, lane.position, lane.is_import)
    }

    const categoryIds = new Map<string, string>()
    for (const category of db.prepare('SELECT id, name, color FROM categories WHERE board_id = ?').all(sourceId) as Array<{ id: string; name: string; color: string }>) {
      const categoryId = randomUUID()
      categoryIds.set(category.id, categoryId)
      db.prepare('INSERT INTO categories (id, board_id, name, color) VALUES (?, ?, ?, ?)').run(categoryId, id, category.name, category.color)
    }

    const labelIds = new Map<string, string>()
    for (const label of db.prepare('SELECT id, name FROM labels WHERE board_id = ?').all(sourceId) as Array<{ id: string; name: string }>) {
      const labelId = randomUUID()
      labelIds.set(label.id, labelId)
      db.prepare('INSERT INTO labels (id, board_id, name) VALUES (?, ?, ?)').run(labelId, id, label.name)
    }

    // The team travels with the structure. The duplicator ends up an admin either way —
    // exactly as if they had created the board by hand.
    db.prepare('INSERT INTO board_members (board_id, user_id, role, may_automate, added_at) SELECT ?, user_id, role, may_automate, ? FROM board_members WHERE board_id = ?')
      .run(id, now, sourceId)
    if (options.creatorId) {
      db.prepare(`
        INSERT INTO board_members (board_id, user_id, role, added_at) VALUES (?, ?, 'admin', ?)
        ON CONFLICT (board_id, user_id) DO UPDATE SET role = 'admin'
      `).run(id, options.creatorId, now)
    }

    if (options.includeTickets) {
      // Numbers are unique instance-wide, so the whole batch draws from one counter read
      // once — the per-row MAX subquery `createTicket` uses would rescan for every ticket.
      let nextNumber = (db.prepare('SELECT COALESCE(MAX(ticket_number), 0) AS value FROM tickets').get() as { value: number }).value
      const insertTicket = db.prepare(`
        INSERT INTO tickets (id, ticket_number, board_id, lane_id, title, description, position, priority, due_date, build_number, source, external_id, created_at, updated_at, archived_at, author_id, assignee_id, category_id, type_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const labelsOf = db.prepare('SELECT label_id FROM ticket_labels WHERE ticket_id = ?')
      const attachLabel = db.prepare('INSERT INTO ticket_labels (ticket_id, label_id) VALUES (?, ?)')
      const todosOf = db.prepare('SELECT text, completed, position FROM ticket_todos WHERE ticket_id = ? ORDER BY position')
      const insertTodo = db.prepare('INSERT INTO ticket_todos (id, ticket_id, text, completed, position) VALUES (?, ?, ?, ?, ?)')
      const feedbackOf = db.prepare('SELECT * FROM apple_feedback WHERE ticket_id = ?')
      const insertFeedback = db.prepare(`
        INSERT INTO apple_feedback (ticket_id, feedback_type, comment, tester_id, device_model, os_version, locale, build_id, build_version, build_bundle_id, source_created_at, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const attachmentsOf = db.prepare('SELECT * FROM attachments WHERE ticket_id = ?')
      const insertAttachment = db.prepare('INSERT INTO attachments (id, ticket_id, kind, filename, mime_type, size, relative_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')

      for (const ticket of db.prepare('SELECT * FROM tickets WHERE board_id = ?').all(sourceId) as TicketRow[]) {
        const ticketId = randomUUID()
        nextNumber += 1
        insertTicket.run(
          ticketId, nextNumber, id, laneIds.get(ticket.lane_id)!, ticket.title, ticket.description,
          ticket.position, ticket.priority, ticket.due_date, ticket.build_number, ticket.source,
          ticket.external_id, ticket.created_at, ticket.updated_at, ticket.archived_at,
          ticket.author_id, ticket.assignee_id, ticket.category_id ? categoryIds.get(ticket.category_id) ?? null : null,
          ticket.type_id
        )
        for (const row of labelsOf.all(ticket.id) as Array<{ label_id: string }>) {
          const labelId = labelIds.get(row.label_id)
          if (labelId) attachLabel.run(ticketId, labelId)
        }
        for (const todo of todosOf.all(ticket.id) as Array<{ text: string; completed: number; position: number }>) {
          insertTodo.run(randomUUID(), ticketId, todo.text, todo.completed, todo.position)
        }
        const feedback = feedbackOf.get(ticket.id) as {
          feedback_type: string; comment: string | null; tester_id: string | null; device_model: string | null
          os_version: string | null; locale: string | null; build_id: string | null; build_version: string | null
          build_bundle_id: string | null; source_created_at: string; raw_json: string
        } | undefined
        if (feedback) {
          insertFeedback.run(
            ticketId, feedback.feedback_type, feedback.comment, feedback.tester_id, feedback.device_model,
            feedback.os_version, feedback.locale, feedback.build_id, feedback.build_version,
            feedback.build_bundle_id, feedback.source_created_at, feedback.raw_json
          )
        }
        for (const attachment of attachmentsOf.all(ticket.id) as Array<{ kind: string; filename: string; mime_type: string; size: number; relative_path: string; created_at: string }>) {
          const relativePath = join(ticketId, `${randomUUID()}${extname(attachment.relative_path)}`)
          insertAttachment.run(randomUUID(), ticketId, attachment.kind, attachment.filename, attachment.mime_type, attachment.size, relativePath, attachment.created_at)
          attachmentCopies.push({ from: attachment.relative_path, to: relativePath })
        }
      }
      // Copied verbatim above; a copy landing in another workspace speaks that workspace's types.
      if (options.workspaceId !== source.workspace_id) retargetTicketTypes(db, id, options.workspaceId)
    }
  })()
  return {
    board: findBoardSummary(id, options.creatorId ? { userId: options.creatorId, instanceAdmin: false } : null)!,
    attachmentCopies
  }
}

/** Same contract as `reorderLanes`: every board of the workspace exactly once, or nothing. */
export function reorderWorkspaceBoards(workspaceId: string, orderedIds: string[]): boolean {
  const db = getDb()
  const existing = (db.prepare('SELECT id FROM boards WHERE workspace_id = ?').all(workspaceId) as Array<{ id: string }>).map(row => row.id)
  if (!existing.length) return false
  const known = new Set(existing)
  if (orderedIds.length !== known.size || orderedIds.some(id => !known.has(id))) return false
  const update = db.prepare('UPDATE boards SET position = ? WHERE id = ? AND workspace_id = ?')
  db.transaction(() => orderedIds.forEach((id, position) => update.run(position, id, workspaceId)))()
  return true
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
  // Board positions live per workspace now, so the workspaces order the list first.
  const rows = (scoped
    ? db.prepare(`
        SELECT b.* FROM boards b
        JOIN board_members m ON m.board_id = b.id AND m.user_id = ?
        JOIN workspaces w ON w.id = b.workspace_id
        ORDER BY w.position, w.created_at, b.position, b.created_at
      `).all(viewer.userId)
    : db.prepare(`
        SELECT b.* FROM boards b
        JOIN workspaces w ON w.id = b.workspace_id
        ORDER BY w.position, w.created_at, b.position, b.created_at
      `).all()) as BoardRow[]
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

export function createBoard(name: string, creatorId: string | null = null, workspaceId?: string): BoardSummary {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  // Callers that predate workspaces — and clients that never picked one — land in the default.
  const workspace = workspaceId ?? defaultWorkspaceId()
  const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM boards WHERE workspace_id = ?').get(workspace) as { position: number }).position
  db.transaction(() => {
    db.prepare('INSERT INTO boards (id, workspace_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)').run(id, workspace, name, position, now)
    db.prepare(`UPDATE boards SET import_type_id = (${DEFAULT_IMPORT_TYPE_SQL}) WHERE id = ?`).run(id)
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
  description?: string
  issuerId?: string
  keyId?: string
  appId?: string
  syncLimit?: number
  autoAuthor?: boolean
  /** Omitted leaves it alone; null clears it. */
  importTypeId?: string | null
}

export function updateBoard(id: string, input: BoardUpdateInput, viewer?: BoardViewer | null): BoardSummary | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM boards WHERE id = ?').get(id) as BoardRow | undefined
  if (!row) return null
  db.prepare('UPDATE boards SET name = ?, description = ?, asc_issuer_id = ?, asc_key_id = ?, asc_app_id = ?, sync_limit = ?, auto_author = ?, import_type_id = ? WHERE id = ?').run(
    input.name ?? row.name,
    input.description ?? row.description,
    input.issuerId ?? row.asc_issuer_id,
    input.keyId ?? row.asc_key_id,
    input.appId ?? row.asc_app_id,
    input.syncLimit ?? row.sync_limit,
    input.autoAuthor === undefined ? row.auto_author : Number(input.autoAuthor),
    input.importTypeId === undefined ? row.import_type_id : input.importTypeId,
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
export function boardSyncCredentials(id: string): { issuerId: string; keyId: string; appId: string; privateKeyPem: string | null; syncLimit: number; autoAuthor: boolean; importTypeId: string | null } | null {
  const row = getDb().prepare('SELECT * FROM boards WHERE id = ?').get(id) as BoardRow | undefined
  if (!row) return null
  return {
    issuerId: row.asc_issuer_id,
    keyId: row.asc_key_id,
    appId: row.asc_app_id,
    privateKeyPem: row.asc_private_key ? decryptSecret(row.asc_private_key) : null,
    syncLimit: row.sync_limit,
    autoAuthor: Boolean(row.auto_author),
    importTypeId: row.import_type_id ?? null
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
  const fullType = row.type_id ? findTicketType(row.type_id) : null
  const type = fullType ? toTicketTypeRef(fullType) : null
  const labels = db.prepare(`SELECT l.id, l.name FROM labels l JOIN ticket_labels tl ON tl.label_id = l.id WHERE tl.ticket_id = ? ORDER BY l.name`).all(row.id) as Label[]
  const feedbackRow = db.prepare('SELECT * FROM apple_feedback WHERE ticket_id = ?').get(row.id) as Record<string, string | null> | undefined
  const attachmentRows = db.prepare('SELECT id, kind, filename, mime_type, size FROM attachments WHERE ticket_id = ? ORDER BY created_at').all(row.id) as Array<{ id: string; kind: Attachment['kind']; filename: string; mime_type: string; size: number }>
  const todoRows = db.prepare('SELECT id, text, completed, position FROM ticket_todos WHERE ticket_id = ? ORDER BY position').all(row.id) as Array<{ id: string; text: string; completed: number; position: number }>
  const commentCount = (db.prepare('SELECT COUNT(*) AS value FROM ticket_comments WHERE ticket_id = ?').get(row.id) as { value: number }).value
  const feedback: AppleFeedback | null = feedbackRow ? {
    feedbackType: feedbackRow.feedback_type as 'screenshot' | 'crash',
    comment: feedbackRow.comment ?? null,
    tester: personById(feedbackRow.tester_id),
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
  const author: TicketAuthor | null = personById(row.author_id)
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
    assignee: personById(row.assignee_id),
    commentCount,
    category: category || null,
    type,
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

/**
 * The same tickets, one page at a time.
 *
 * Ordered by ticket number rather than by lane and position, which is what the board view
 * uses: a cursor has to be stable, and lane order is exactly the thing a caller paging
 * through a board is likely to be changing underneath itself. The number never moves.
 *
 * The cursor is the last number seen, so a page boundary is `ticket_number > cursor`.
 */
export function listTicketsPage(boardId: string, options: { archived?: boolean; limit: number; cursor?: number | null }): { tickets: Ticket[]; nextCursor: number | null } {
  const rows = getDb().prepare(`
    SELECT t.* FROM tickets t
    WHERE t.board_id = ? AND t.archived_at IS ${options.archived ? 'NOT ' : ''}NULL
      AND t.ticket_number > ?
    ORDER BY t.ticket_number
    LIMIT ?
  `).all(boardId, options.cursor ?? 0, options.limit + 1) as TicketRow[]

  // One row past the page is how the presence of a next page is known without a second count.
  const hasMore = rows.length > options.limit
  const page = hasMore ? rows.slice(0, options.limit) : rows
  return {
    tickets: page.map(hydrateTicket),
    nextCursor: hasMore ? page.at(-1)!.ticket_number : null
  }
}

export function findTicket(id: string): Ticket | null {
  const row = getDb().prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined
  return row ? hydrateTicket(row) : null
}

/**
 * The id behind a ticket number.
 *
 * Numbers are unique across the instance rather than per board, so this needs nothing to
 * disambiguate it. That is the point: "ticket 42" is how a person — and an agent reading
 * after them — refers to one, and resolving it should not cost a board lookup first.
 */
export function ticketIdByNumber(ticketNumber: number): string | null {
  const row = getDb().prepare('SELECT id FROM tickets WHERE ticket_number = ?').get(ticketNumber) as { id: string } | undefined
  return row?.id ?? null
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

/* ── ticket types ───────────────────────────────────────────────────────── */

export function listTicketTypes(workspaceId: string): TicketTypeSummary[] {
  const rows = getDb().prepare(`
    SELECT tt.*, COUNT(t.id) AS ticket_count
    FROM ticket_types tt
    LEFT JOIN tickets t ON t.type_id = tt.id
    WHERE tt.workspace_id = ?
    GROUP BY tt.id
    ORDER BY tt.position, tt.created_at
  `).all(workspaceId) as Array<TicketTypeRow & { ticket_count: number }>
  return rows.map(row => ({ ...toTicketType(row), ticketCount: row.ticket_count }))
}

export function findTicketType(id: string): TicketType | null {
  const row = getDb().prepare('SELECT * FROM ticket_types WHERE id = ?').get(id) as TicketTypeRow | undefined
  return row ? toTicketType(row) : null
}

export class TicketTypeNameTakenError extends Error {
  constructor(message: string) {
    super(message)
  }
}

export interface TicketTypeInput {
  name: string
  color: TicketTypeColor
  icon: TicketTypeIcon
}

export function createTicketType(workspaceId: string, input: TicketTypeInput): TicketType | null {
  const db = getDb()
  if (!findWorkspace(workspaceId)) return null
  const name = input.name.trim()
  if (db.prepare('SELECT 1 FROM ticket_types WHERE workspace_id = ? AND name = ? COLLATE NOCASE').get(workspaceId, name)) {
    throw new TicketTypeNameTakenError(`This workspace already has a type named “${name}”.`)
  }
  const id = randomUUID()
  const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM ticket_types WHERE workspace_id = ?').get(workspaceId) as { position: number }).position
  const [kind, value] = iconColumns(input.icon)
  db.prepare('INSERT INTO ticket_types (id, workspace_id, name, color, icon_kind, icon_value, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, workspaceId, name, input.color, kind, value, position, new Date().toISOString())
  return findTicketType(id)
}

/** One call for name, colour and icon, so changing one cannot lose another. */
export function updateTicketType(id: string, input: Partial<TicketTypeInput>): TicketType | null {
  const db = getDb()
  const existing = findTicketType(id)
  if (!existing) return null
  const name = input.name?.trim() || existing.name
  const clash = db.prepare('SELECT id FROM ticket_types WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND id <> ?')
    .get(existing.workspaceId, name, id) as { id: string } | undefined
  if (clash) throw new TicketTypeNameTakenError(`This workspace already has a type named “${name}”.`)
  const [kind, value] = iconColumns(input.icon ?? existing.icon)
  db.prepare('UPDATE ticket_types SET name = ?, color = ?, icon_kind = ?, icon_value = ? WHERE id = ?')
    .run(name, input.color ?? existing.color, kind, value, id)
  return findTicketType(id)
}

/** Tickets of the type fall back to "no type" — the column is `ON DELETE SET NULL`. */
export function deleteTicketType(id: string): boolean {
  return getDb().prepare('DELETE FROM ticket_types WHERE id = ?').run(id).changes > 0
}

/** Same contract as `reorderLanes`: every type of the workspace exactly once, or nothing. */
export function reorderTicketTypes(workspaceId: string, orderedIds: string[]): TicketTypeSummary[] | null {
  const db = getDb()
  const existing = listTicketTypes(workspaceId)
  if (!existing.length) return null
  const known = new Set(existing.map(type => type.id))
  if (orderedIds.length !== known.size || orderedIds.some(id => !known.has(id))) return null
  const update = db.prepare('UPDATE ticket_types SET position = ? WHERE id = ? AND workspace_id = ?')
  db.transaction(() => orderedIds.forEach((id, position) => update.run(position, id, workspaceId)))()
  return listTicketTypes(workspaceId)
}

/**
 * Whether a type may be put on a ticket of this board — i.e. it belongs to the board's
 * workspace. Tickets carry no workspace column, so the database cannot say this by itself.
 */
export function ticketTypeBelongsToBoard(typeId: string, boardId: string): boolean {
  return Boolean(getDb().prepare(`
    SELECT 1 FROM ticket_types tt JOIN boards b ON b.workspace_id = tt.workspace_id
    WHERE tt.id = ? AND b.id = ?
  `).get(typeId, boardId))
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
  /** A type of the board's workspace; the caller has checked that. Null or omitted: untyped. */
  typeId?: string | null
  todos?: TicketTodoInput[]
  assigneeId?: string | null
  /** Admin-only: who a ticket is attributed to, independent of who is editing it. */
  authorId?: string | null
  /** Where in its lane the ticket lands. Bottom when omitted; only `createTicket` reads it. */
  placement?: 'top' | 'bottom'
}

function nextPosition(laneId: string): number {
  return (getDb().prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tickets WHERE lane_id = ? AND archived_at IS NULL').get(laneId) as { position: number }).position
}

/**
 * Appends one entry to a ticket's history. Always called from inside the caller's
 * transaction. Person-valued payload keys hold ids, never addresses — an entry that spelled
 * out an email would keep naming somebody the moment their account is anonymized.
 */
function recordActivity(ticketId: string, actor: Actor | null, kind: ActivityKind, payload: Record<string, string | null> = {}) {
  getDb().prepare('INSERT INTO ticket_activity (id, ticket_id, actor_id, agent_id, channel, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), ticketId, actor?.principalId ?? null, actor?.agentId ?? null, actor?.channel ?? 'web', kind, JSON.stringify(payload), new Date().toISOString())
}

export function createTicket(boardId: string, input: TicketInput, author: Person | null = null, actor: Actor | null = null): Ticket | null {
  const db = getDb()
  // A lane may be named by the caller — the board's own lane, or nothing.
  const requested = input.laneId ? findLane(input.laneId) : null
  const lane = requested?.boardId === boardId ? requested : defaultLaneFor(boardId)
  if (!lane) return null
  const id = randomUUID()
  const now = new Date().toISOString()
  db.transaction(() => {
    const categoryId = resolveCategoryId(boardId, input.categoryName)
    // Appended first either way; a ticket asked to the top is then shuffled with the lane.
    const position = nextPosition(lane.id)
    db.prepare(`INSERT INTO tickets (id, ticket_number, board_id, lane_id, title, description, position, priority, due_date, build_number, source, created_at, updated_at, author_id, assignee_id, category_id, type_id)
      VALUES (?, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tickets), ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?)`).run(
      id, boardId, lane.id, input.title, input.description || '', position, input.priority || 'medium',
      input.dueDate || null, input.buildNumber || null, now, now,
      author?.id || null, input.assigneeId || null, categoryId, input.typeId || null
    )
    if (input.placement === 'top') {
      const rest = (db.prepare('SELECT id FROM tickets WHERE lane_id = ? AND archived_at IS NULL ORDER BY position, created_at').all(lane.id) as Array<{ id: string }>)
        .map(row => row.id).filter(ticketId => ticketId !== id)
      reindexLane(lane.id, [id, ...rest])
    }
    setTicketLabels(id, boardId, input.labels || [])
    setTicketTodos(id, input.todos || [])
    recordActivity(id, actor, 'created', { lane: lane.name })
    if (input.assigneeId) recordActivity(id, actor, 'assigned', { to: input.assigneeId })
    if (input.typeId) recordActivity(id, actor, 'type', { from: null, to: findTicketType(input.typeId)?.name ?? null })
  })()
  return findTicket(id)!
}

export function updateTicket(id: string, input: Partial<TicketInput>, actor: Actor | null = null): Ticket | null {
  const existing = findTicket(id)
  if (!existing) return null
  const now = new Date().toISOString()
  const priority = input.priority ?? existing.priority
  const dueDate = input.dueDate === undefined ? existing.dueDate : input.dueDate || null
  const assigneeId = input.assigneeId === undefined ? existing.assignee?.id || null : input.assigneeId || null
  const authorId = input.authorId === undefined ? existing.author?.id || null : input.authorId || null
  const typeId = input.typeId === undefined ? existing.type?.id || null : input.typeId || null
  getDb().transaction(() => {
    const categoryId = input.categoryName === undefined ? existing.category?.id || null : resolveCategoryId(existing.boardId, input.categoryName)
    getDb().prepare(`UPDATE tickets SET title = ?, description = ?, priority = ?, due_date = ?, build_number = ?, assignee_id = ?, author_id = ?, category_id = ?, type_id = ?, updated_at = ? WHERE id = ?`).run(
      input.title ?? existing.title,
      input.description ?? existing.description,
      priority,
      dueDate,
      input.buildNumber === undefined ? (existing.source === 'manual' ? existing.buildNumber : null) : input.buildNumber || null,
      assigneeId,
      authorId,
      categoryId,
      typeId,
      now,
      id
    )
    if (input.labels) setTicketLabels(id, existing.boardId, input.labels)
    if (input.todos !== undefined) setTicketTodos(id, input.todos)
    if (priority !== existing.priority) recordActivity(id, actor, 'priority', { from: existing.priority, to: priority })
    if (dueDate !== existing.dueDate) recordActivity(id, actor, 'due_date', { from: existing.dueDate, to: dueDate })
    if (assigneeId !== (existing.assignee?.id || null)) {
      recordActivity(id, actor, assigneeId ? 'assigned' : 'unassigned', { from: existing.assignee?.id || null, to: assigneeId })
    }
    if (authorId !== (existing.author?.id || null)) {
      recordActivity(id, actor, 'author', { from: existing.author?.id || null, to: authorId })
    }
    if (typeId !== (existing.type?.id || null)) {
      // Names rather than ids: a type may be deleted later, and the history should still read.
      recordActivity(id, actor, 'type', { from: existing.type?.name ?? null, to: typeId ? findTicketType(typeId)?.name ?? null : null })
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

export function moveTicket(id: string, targetLaneId: string, targetIndex: number, actor: Actor | null = null): Ticket | null {
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
      recordActivity(id, actor, 'moved', { from: findLane(current.laneId)?.name || null, to: targetLane.name })
    }
    reindexLane(targetLaneId, targetIds)
  })()
  return findTicket(id)
}

export function archiveTicket(id: string, actor: Actor | null = null): Ticket | null {
  const now = new Date().toISOString()
  const result = getDb().prepare('UPDATE tickets SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL').run(now, now, id)
  if (!result.changes) return null
  recordActivity(id, actor, 'archived')
  return findTicket(id)
}

export function restoreTicket(id: string, actor: Actor | null = null): Ticket | null {
  const db = getDb()
  const ticket = findTicket(id)
  if (!ticket || !ticket.archivedAt) return null
  const lane = findLane(ticket.laneId) || defaultLaneFor(ticket.boardId)
  if (!lane) return null
  const now = new Date().toISOString()
  db.prepare('UPDATE tickets SET archived_at = NULL, lane_id = ?, position = ?, updated_at = ? WHERE id = ?')
    .run(lane.id, nextPosition(lane.id), now, id)
  recordActivity(id, actor, 'restored', { lane: lane.name })
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
  /** Whether a tester who already has an account is recorded as the ticket's author. */
  autoAuthor?: boolean
  /** The board's import type. An id that no longer exists is treated as none. */
  typeId?: string | null
}

export function insertImportedTicket(input: ImportedTicketInput): Ticket {
  const db = getDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  const position = nextPosition(input.laneId)
  // Apple gives us an address, so the tester always gets a row. Attributing the ticket to
  // them is a separate question: only somebody who already has an account here can be its
  // author, and only while the board asks for it.
  const testerId = input.testerEmail ? upsertContactByEmail(input.testerEmail) : null
  const authorId = input.autoAuthor !== false && personById(testerId)?.isAccount ? testerId : null
  // Resolved rather than trusted: a sync reads the board's settings once and may still be
  // running when somebody deletes the type. An import must never fail over a type; it
  // simply arrives untyped, exactly as the board would be configured a moment later.
  const type = input.typeId ? findTicketType(input.typeId) : null
  db.transaction(() => {
    db.prepare(`INSERT INTO tickets (id, ticket_number, board_id, lane_id, title, description, position, priority, source, external_id, created_at, updated_at, author_id, type_id)
      VALUES (?, (SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM tickets), ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.boardId, input.laneId, input.title, position, input.type === 'crash' ? 'high' : 'medium',
      input.type === 'crash' ? 'testflight_crash' : 'testflight_screenshot', input.externalId, now, now, authorId, type?.id ?? null
    )
    db.prepare(`INSERT INTO apple_feedback (ticket_id, feedback_type, comment, tester_id, device_model, os_version, locale, build_id, build_version, build_bundle_id, source_created_at, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.type, input.comment, testerId, input.deviceModel, input.osVersion, input.locale,
      input.buildId, input.buildVersion, input.buildBundleId, input.sourceCreatedAt, JSON.stringify(input.raw)
    )
    setTicketLabels(id, input.boardId, ['TestFlight', input.type === 'crash' ? 'Crash' : 'Screenshot'])
    // No actor: the ticket came from Apple, not from anyone signed in here.
    recordActivity(id, null, 'created', { source: input.type })
    if (type) recordActivity(id, null, 'type', { from: null, to: type.name })
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
 * Everything person-shaped is keyed by user id. Somebody who has never signed in still
 * gets a row — a `contact` — so a ticket can point at them; inviting that address later
 * claims the same row, and everything already attached to it follows along.
 * -------------------------------------------------------------------------- */

export interface UserRecord {
  id: string
  /** null once anonymized. Such an account is disabled, so nothing can sign in as it. */
  email: string | null
  firstName: string
  lastName: string
  passwordHash: string | null
  role: UserRole
  status: UserStatus
  sessionVersion: number
  inviteTokenHash: string | null
  inviteExpiresAt: string | null
  anonymizedAt: string | null
  createdAt: string
  lastLoginAt: string | null
}

type UserRow = {
  id: string; email: string | null; first_name: string; last_name: string; password_hash: string | null
  kind: UserKind; role: UserRole; status: UserStatus; session_version: number; invite_token_hash: string | null
  invite_expires_at: string | null; anonymized_at: string | null; created_at: string; last_login_at: string | null
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
    anonymizedAt: row.anonymized_at,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  }
}

export function listUsers(): UserAccount[] {
  const db = getDb()
  const accounts = db.prepare(`
    SELECT u.id, u.email, u.first_name AS firstName, u.last_name AS lastName, u.role, u.status,
           u.created_at AS createdAt, u.last_login_at AS lastLoginAt, u.invite_expires_at AS inviteExpiresAt,
           u.anonymized_at AS anonymizedAt
    FROM users u
    WHERE u.kind = 'account'
    ORDER BY u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE, u.email COLLATE NOCASE
  `).all() as Omit<UserAccount, 'boards'>[]

  // One query for every membership rather than one per account, grouped in the order the
  // boards themselves are shown so a row reads the same as the board switcher.
  const memberships = db.prepare(`
    SELECT m.user_id AS userId, b.id AS boardId, b.name AS boardName, m.role
    FROM board_members m
    JOIN boards b ON b.id = m.board_id
    ORDER BY b.position, b.created_at
  `).all() as (UserBoardMembership & { userId: string })[]

  const byUser = new Map<string, UserBoardMembership[]>()
  for (const { userId, ...membership } of memberships) {
    const list = byUser.get(userId)
    if (list) list.push(membership)
    else byUser.set(userId, [membership])
  }

  return accounts.map(account => ({ ...account, boards: byUser.get(account.id) || [] }))
}

export function countUsers(): number {
  return (getDb().prepare("SELECT COUNT(*) AS value FROM users WHERE kind = 'account'").get() as { value: number }).value
}

/**
 * An account: somebody who can sign in. Deliberately blind to service identities, so that
 * everything built on it — sessions, the invite flow, the user admin screens — cannot reach
 * a machine principal by id and treat it as a person.
 */
export function findUser(id: string): UserRecord | null {
  const row = getDb().prepare("SELECT * FROM users WHERE id = ? AND kind = 'account'").get(id) as UserRow | undefined
  return row ? toUser(row) : null
}

/**
 * Anybody who can *act*: an account or a service identity, never a contact.
 *
 * This is what a token resolves against. Keeping it separate from `findUser` is what stops a
 * service identity from being invited, given a password, or listed as a colleague.
 */
export function findPrincipal(id: string): UserRecord | null {
  const row = getDb().prepare("SELECT * FROM users WHERE id = ? AND kind IN ('account', 'service')").get(id) as UserRow | undefined
  return row ? toUser(row) : null
}

/** Sets the status of a principal `updateUser` will not touch, which is a service identity. */
export function setPrincipalStatus(id: string, status: UserStatus): UserRecord | null {
  const changed = getDb().prepare("UPDATE users SET status = ?, session_version = session_version + 1 WHERE id = ? AND kind = 'service'").run(status, id).changes
  if (!changed) return null
  invalidateUserDirectory()
  return findPrincipal(id)
}

/** Accounts only: a contact has no password, and must never be a login candidate. */
export function findUserByEmail(email: string): UserRecord | null {
  const row = getDb().prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE AND kind = 'account'").get(email.trim()) as UserRow | undefined
  return row ? toUser(row) : null
}

export function findUserByInviteToken(tokenHash: string): UserRecord | null {
  const row = getDb().prepare('SELECT * FROM users WHERE invite_token_hash = ?').get(tokenHash) as UserRow | undefined
  return row ? toUser(row) : null
}

export class EmailTakenError extends Error {
  constructor() { super('An account with this email address already exists.') }
}

export class AnonymizedAccountError extends Error {
  constructor() { super('An anonymized account cannot be changed or invited back.') }
}

export interface UserCreateInput {
  email: string
  firstName: string
  lastName: string
  role: UserRole
}

/**
 * Invites somebody. When that address is already known as a contact — an imported
 * TestFlight tester, the author of an old ticket — the invitation claims their existing
 * row rather than opening a second one, so every ticket, comment and activity entry that
 * already points at them belongs to the new account from the moment it is created.
 */
/**
 * Opens a machine account.
 *
 * No address and no password: a service identity cannot sign in and exists only to be acted
 * through by a token. It is otherwise an ordinary principal — it takes board memberships and
 * roles like anyone, appears in the history under its own name, and `status` disables it and
 * every token that names it in one move.
 *
 * `role` is fixed at `member`: an instance administrator that nobody can log in as, whose
 * whole reach is a token, is not a thing this should be able to create by accident.
 */
export function createServiceIdentity(name: string): UserRecord {
  const id = randomUUID()
  getDb().prepare(`
    INSERT INTO users (id, email, first_name, last_name, kind, role, status, created_at)
    VALUES (?, NULL, ?, '', 'service', 'member', 'active', ?)
  `).run(id, name.trim(), new Date().toISOString())
  invalidateUserDirectory()
  return findPrincipal(id)!
}

export function listServiceIdentities(): UserRecord[] {
  const rows = getDb().prepare("SELECT id FROM users WHERE kind = 'service' ORDER BY created_at DESC").all() as Array<{ id: string }>
  return rows.map(row => findPrincipal(row.id)!).filter(Boolean)
}

export function isServiceIdentity(account: UserRecord): boolean {
  const row = getDb().prepare('SELECT kind FROM users WHERE id = ?').get(account.id) as { kind: string } | undefined
  return row?.kind === 'service'
}

export function createUser(input: UserCreateInput): UserRecord {
  const db = getDb()
  const email = input.email.trim().toLowerCase()
  const existing = db.prepare('SELECT id, kind FROM users WHERE email = ? COLLATE NOCASE').get(email) as { id: string; kind: UserKind } | undefined
  if (existing?.kind === 'account') throw new EmailTakenError()

  const id = existing?.id || randomUUID()
  if (existing) {
    db.prepare(`
      UPDATE users SET first_name = ?, last_name = ?, kind = 'account', role = ?, status = 'invited' WHERE id = ?
    `).run(input.firstName, input.lastName, input.role, id)
  } else {
    db.prepare(`
      INSERT INTO users (id, email, first_name, last_name, kind, role, status, created_at)
      VALUES (?, ?, ?, ?, 'account', ?, 'invited', ?)
    `).run(id, email, input.firstName, input.lastName, input.role, new Date().toISOString())
  }
  invalidateUserDirectory()
  return findUser(id)!
}

export interface UserUpdateInput {
  email?: string
  firstName?: string
  lastName?: string
  role?: UserRole
  status?: UserStatus
}

/** Swaps one person for another everywhere an activity payload names them. */
function repointPayloadPerson(db: Database.Database, fromId: string, toId: string) {
  const kinds = Object.keys(personPayloadKeys)
  const rows = db.prepare(`SELECT id, kind, payload FROM ticket_activity WHERE kind IN (${kinds.map(() => '?').join(', ')})`)
    .all(...kinds) as Array<{ id: string; kind: ActivityKind; payload: string }>
  const update = db.prepare('UPDATE ticket_activity SET payload = ? WHERE id = ?')
  for (const row of rows) {
    const payload = safeJson(row.payload)
    let touched = false
    for (const key of personPayloadKeys[row.kind] || []) {
      if (payload[key] === fromId) {
        payload[key] = toId
        touched = true
      }
    }
    if (touched) update.run(JSON.stringify(payload), row.id)
  }
}

/**
 * Folds a contact into the account that is taking its address. An address only ever belongs
 * to one person, so these two rows are the same human: everything the contact is named on
 * moves across and the contact row goes away.
 *
 * This is the other direction of what `createUser` does. There the account does not exist
 * yet, so the contact row simply becomes it; here it already has an id of its own, and the
 * references have to be carried over instead. Runs inside the caller's transaction.
 */
function absorbContact(db: Database.Database, contactId: string, accountId: string) {
  db.prepare('UPDATE tickets SET author_id = ? WHERE author_id = ?').run(accountId, contactId)
  db.prepare('UPDATE tickets SET assignee_id = ? WHERE assignee_id = ?').run(accountId, contactId)
  db.prepare('UPDATE ticket_comments SET author_id = ? WHERE author_id = ?').run(accountId, contactId)
  db.prepare('UPDATE ticket_activity SET actor_id = ? WHERE actor_id = ?').run(accountId, contactId)
  db.prepare('UPDATE apple_feedback SET tester_id = ? WHERE tester_id = ?').run(accountId, contactId)
  repointPayloadPerson(db, contactId, accountId)
  db.prepare("DELETE FROM users WHERE id = ? AND kind = 'contact'").run(contactId)
}

/**
 * Changing the address is a one-row edit: everything that names this person holds their id,
 * so nothing has to be rewritten and nothing is orphaned. The one exception is an address
 * already known as a contact — the tester who turns out to be a colleague — which is folded
 * into the account rather than refused.
 */
export function updateUser(id: string, input: UserUpdateInput): UserRecord | null {
  const db = getDb()
  const existing = findUser(id)
  if (!existing) return null
  // A tombstone stays a tombstone. Letting one be renamed and re-enabled would hand the
  // erased person's history to whoever the row was pointed at next.
  if (existing.anonymizedAt) throw new AnonymizedAccountError()

  const email = input.email === undefined ? existing.email : input.email.trim().toLowerCase()
  let contactToAbsorb: string | null = null
  if (email && email !== existing.email) {
    const holder = db.prepare('SELECT id, kind FROM users WHERE email = ? COLLATE NOCASE').get(email) as { id: string; kind: UserKind } | undefined
    if (holder && holder.id !== id) {
      if (holder.kind === 'account') throw new EmailTakenError()
      contactToAbsorb = holder.id
    }
  }

  const status = input.status ?? existing.status
  // Locking an account out only helps if the sessions it already has stop working.
  const sessionVersion = status === 'disabled' && existing.status !== 'disabled' ? existing.sessionVersion + 1 : existing.sessionVersion
  db.transaction(() => {
    // Before the update: the contact still holds the address under a unique index.
    if (contactToAbsorb) absorbContact(db, contactToAbsorb, id)
    db.prepare('UPDATE users SET email = ?, first_name = ?, last_name = ?, role = ?, status = ?, session_version = ? WHERE id = ?').run(
      email,
      input.firstName ?? existing.firstName,
      input.lastName ?? existing.lastName,
      input.role ?? existing.role,
      status,
      sessionVersion,
      id
    )
  })()
  invalidateUserDirectory()
  return findUser(id)
}

/**
 * Erases the person while keeping everything they did. The row stays, so every ticket,
 * comment and activity entry that points at it stays attached and simply stops naming
 * anybody; the address is released, and the account can no longer be signed in to.
 */
export function anonymizeUser(id: string): UserRecord | null {
  const existing = findUser(id)
  if (!existing) return null
  const db = getDb()
  db.transaction(() => {
    db.prepare(`
      UPDATE users
      SET email = NULL, first_name = '', last_name = '', password_hash = NULL, status = 'disabled',
          invite_token_hash = NULL, invite_expires_at = NULL, anonymized_at = COALESCE(anonymized_at, ?),
          session_version = session_version + 1
      WHERE id = ?
    `).run(new Date().toISOString(), id)
    // Erased means gone from the boards too: nobody should still be able to pick them.
    db.prepare('DELETE FROM board_members WHERE user_id = ?').run(id)
  })()
  invalidateUserDirectory()
  return findUser(id)
}

/**
 * Removes the row outright. Every ticket, comment and activity entry that pointed at it
 * survives with a null person — use `anonymizeUser` to keep the history readable as one
 * person's, and this only when the row itself should not exist.
 */
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
  // An erased account has no way back in, and issuing a link would be exactly that.
  if (findUser(id)?.anonymizedAt) throw new AnonymizedAccountError()
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

/**
 * Takes any principal: a service identity holds a board role exactly as a person does.
 *
 * `mayAutomate` left undefined keeps whatever the membership already had, so a caller that
 * only means to change the role cannot revoke the permission by omission.
 */
export function setBoardMember(boardId: string, userId: string, role: BoardRole, mayAutomate?: boolean): BoardMember | null {
  if (!findBoard(boardId) || !findPrincipal(userId)) return null
  const flag = mayAutomate === undefined ? null : (mayAutomate ? 1 : 0)
  getDb().prepare(`
    INSERT INTO board_members (board_id, user_id, role, may_automate, added_at) VALUES (?, ?, ?, COALESCE(?, 0), ?)
    ON CONFLICT (board_id, user_id) DO UPDATE SET role = excluded.role, may_automate = COALESCE(?, may_automate)
  `).run(boardId, userId, role, flag, new Date().toISOString(), flag)
  return boardMembers(boardId).find(member => member.userId === userId) || null
}

export function removeBoardMember(boardId: string, userId: string): boolean {
  return getDb().prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?').run(boardId, userId).changes > 0
}

export function countBoardAdmins(boardId: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS value FROM board_members WHERE board_id = ? AND role = 'admin'").get(boardId) as { value: number }).value
}

type CommentRow = { id: string; ticket_id: string; author_id: string | null; body: string; created_at: string; updated_at: string }

function toComment(row: CommentRow): TicketComment {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    author: personById(row.author_id),
    authorId: row.author_id,
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

/**
 * The author is a person, not necessarily an account: a TestFlight tester who has never
 * signed in can hold a comment, so authorship stays a plain person id. The actor is who
 * performed the write and may be null when nothing did — an import, a migration.
 */
export function createComment(ticketId: string, authorId: string, body: string, actor: Actor | null = null): TicketComment | null {
  const db = getDb()
  if (!db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(ticketId)) return null
  const id = randomUUID()
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare('INSERT INTO ticket_comments (id, ticket_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, ticketId, authorId, body, now, now)
    recordActivity(ticketId, actor, 'commented')
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

type ActivityRow = { id: string; ticket_id: string; actor_id: string | null; agent_id: string | null; channel: ActorChannel; kind: ActivityKind; payload: string; created_at: string }

function toActivityEntry(row: ActivityRow): TicketActivityEntry {
  const payload = safeJson(row.payload)
  // Person-valued keys are ids on disk; the reader wants people, and an id whose row is
  // gone resolves to null rather than showing a stranger a raw uuid.
  const payloadPeople: Record<string, Person | null> = {}
  for (const key of personPayloadKeys[row.kind] || []) payloadPeople[key] = personById(payload[key])
  return {
    id: row.id,
    ticketId: row.ticket_id,
    actor: personById(row.actor_id),
    // Provenance, not attribution: the actor still answers for the change.
    agentId: row.agent_id,
    channel: row.channel,
    kind: row.kind,
    payload,
    payloadPeople,
    createdAt: row.created_at,
  }
}

export function listActivity(ticketId: string, limit = 100): TicketActivityEntry[] {
  const rows = getDb().prepare('SELECT * FROM ticket_activity WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(ticketId, limit) as ActivityRow[]
  return rows.map(toActivityEntry)
}

/** A whole board's recent history in one query, newest first — what a digest is made of. */
export function listBoardActivity(boardId: string, options: { since?: string; limit?: number } = {}): Array<TicketActivityEntry & { ticketNumber: number; ticketTitle: string }> {
  const rows = getDb().prepare(`
    SELECT a.*, t.ticket_number, t.title
    FROM ticket_activity a
    JOIN tickets t ON t.id = a.ticket_id
    WHERE t.board_id = ? AND a.created_at >= ?
    ORDER BY a.created_at DESC, a.rowid DESC
    LIMIT ?
  `).all(boardId, options.since ?? '', options.limit ?? 50) as Array<ActivityRow & { ticket_number: number; title: string }>
  return rows.map(row => ({ ...toActivityEntry(row), ticketNumber: row.ticket_number, ticketTitle: row.title }))
}

function safeJson(value: string): Record<string, string | null> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
