import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

/**
 * A database in the shape it had just before the identity refactor: boards and lanes in
 * place, accounts in place, and every person still named by a raw email address.
 */
function legacyDatabase() {
  const legacy = new Database(':memory:')
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE boards (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL,
      asc_issuer_id TEXT NOT NULL DEFAULT '', asc_key_id TEXT NOT NULL DEFAULT '',
      asc_app_id TEXT NOT NULL DEFAULT '', asc_private_key TEXT, asc_key_filename TEXT,
      asc_key_uploaded_at TEXT, sync_limit INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL
    );
    CREATE TABLE lanes (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL, position INTEGER NOT NULL, is_import INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE categories (
      id TEXT PRIMARY KEY, board_id TEXT REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE, color TEXT NOT NULL DEFAULT 'neutral'
    );
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, ticket_number INTEGER NOT NULL UNIQUE,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      lane_id TEXT NOT NULL REFERENCES lanes(id), title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL,
      priority TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
      due_date TEXT, build_number TEXT,
      source TEXT NOT NULL CHECK (source IN ('manual', 'testflight_screenshot', 'testflight_crash')),
      external_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
      author_first_name TEXT, author_last_name TEXT, author_email TEXT, assignee_email TEXT,
      category_id TEXT REFERENCES categories(id) ON DELETE SET NULL
    );
    CREATE TABLE apple_feedback (
      ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
      feedback_type TEXT NOT NULL CHECK (feedback_type IN ('screenshot', 'crash')),
      comment TEXT, tester_email TEXT, device_model TEXT, os_version TEXT, locale TEXT,
      build_id TEXT, build_version TEXT, build_bundle_id TEXT,
      source_created_at TEXT NOT NULL, raw_json TEXT NOT NULL
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '',
      password_hash TEXT, role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'invited', session_version INTEGER NOT NULL DEFAULT 1,
      invite_token_hash TEXT, invite_expires_at TEXT, created_at TEXT NOT NULL, last_login_at TEXT
    );
    CREATE TABLE board_members (
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'editor', added_at TEXT NOT NULL,
      PRIMARY KEY (board_id, user_id)
    );
    CREATE TABLE ticket_comments (
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      author_email TEXT NOT NULL, body TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE ticket_activity (
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      actor_email TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );

    INSERT INTO boards (id, name, position, created_at) VALUES ('b1', 'Workboard', 0, '2026-01-01');
    INSERT INTO lanes VALUES ('l-import', 'b1', 'Import', 0, 1), ('l-backlog', 'b1', 'Backlog', 1, 0);
    INSERT INTO users (id, email, first_name, last_name, role, status, created_at)
      VALUES ('u-grace', 'Grace@example.com', 'Grace', 'Hopper', 'owner', 'active', '2026-01-01');
    INSERT INTO board_members VALUES ('b1', 'u-grace', 'admin', '2026-01-01');

    INSERT INTO tickets (id, ticket_number, board_id, lane_id, title, position, priority, source, created_at, updated_at, author_first_name, author_last_name, author_email, assignee_email)
      VALUES ('t-manual', 1, 'b1', 'l-backlog', 'Filed by hand', 0, 'medium', 'manual', '2026-01-02', '2026-01-02', 'Ada', 'Lovelace', 'ada@example.com', 'GRACE@example.com');
    INSERT INTO tickets (id, ticket_number, board_id, lane_id, title, position, priority, source, external_id, created_at, updated_at)
      VALUES ('t-known', 2, 'b1', 'l-import', 'Crash from a colleague', 0, 'high', 'testflight_crash', 'x1', '2026-01-03', '2026-01-03'),
             ('t-stranger', 3, 'b1', 'l-import', 'Crash from a stranger', 1, 'high', 'testflight_crash', 'x2', '2026-01-03', '2026-01-03');
    INSERT INTO apple_feedback VALUES
      ('t-known', 'crash', 'It broke', 'grace@example.com', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-03', '{}'),
      ('t-stranger', 'crash', 'It broke', 'outsider@example.com', NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-03', '{}');

    INSERT INTO ticket_comments VALUES ('c1', 't-manual', 'ada@example.com', 'A note', '2026-01-04', '2026-01-04');
    INSERT INTO ticket_activity VALUES
      ('a1', 't-manual', 'grace@example.com', 'assigned', '{"from":null,"to":"GRACE@example.com"}', '2026-01-04'),
      ('a2', 't-manual', NULL, 'moved', '{"from":"Import","to":"Backlog"}', '2026-01-04');
  `)
  return legacy
}

describe('the person-identity migration', () => {
  it('turns every stored address into a user id and keeps the history attached', async () => {
    const db = await import('../server/utils/db')
    const legacy = legacyDatabase()

    expect(db.ensurePersonIdentity(legacy)).toBe(true)
    // Idempotent: a second boot must not rebuild anything.
    expect(db.ensurePersonIdentity(legacy)).toBe(false)

    const byEmail = Object.fromEntries((legacy.prepare('SELECT id, email, kind, first_name, status FROM users').all() as Array<{
      id: string; email: string; kind: string; first_name: string; status: string | null
    }>).map(row => [row.email, row]))

    // The account keeps its row and its id; everyone else gains one.
    expect(byEmail['Grace@example.com']).toMatchObject({ id: 'u-grace', kind: 'account', status: 'active' })
    expect(byEmail['ada@example.com']).toMatchObject({ kind: 'contact', first_name: 'Ada', status: null })
    expect(byEmail['outsider@example.com']).toMatchObject({ kind: 'contact', status: null })

    const manual = legacy.prepare('SELECT author_id, assignee_id FROM tickets WHERE id = ?').get('t-manual') as { author_id: string; assignee_id: string }
    expect(manual.author_id).toBe(byEmail['ada@example.com']!.id)
    // Matched case-insensitively, the way the addresses were always compared.
    expect(manual.assignee_id).toBe('u-grace')

    expect(legacy.prepare('SELECT author_id FROM ticket_comments WHERE id = ?').get('c1')).toEqual({ author_id: byEmail['ada@example.com']!.id })
    expect(legacy.prepare('SELECT actor_id FROM ticket_activity WHERE id = ?').get('a1')).toEqual({ actor_id: 'u-grace' })

    // The address buried in the assignment payload is an id now, so anonymizing reaches it.
    expect(legacy.prepare('SELECT payload FROM ticket_activity WHERE id = ?').get('a1')).toEqual({ payload: '{"from":null,"to":"u-grace"}' })
    // A payload that never named a person is left exactly as it was.
    expect(legacy.prepare('SELECT payload FROM ticket_activity WHERE id = ?').get('a2')).toEqual({ payload: '{"from":"Import","to":"Backlog"}' })

    // The import rule, applied to what was imported before it existed.
    expect(legacy.prepare('SELECT author_id FROM tickets WHERE id = ?').get('t-known')).toEqual({ author_id: 'u-grace' })
    // The stranger has a contact row but no account, so their ticket stays unattributed.
    expect(legacy.prepare('SELECT author_id, tester_id FROM tickets JOIN apple_feedback ON ticket_id = id WHERE id = ?').get('t-stranger'))
      .toEqual({ author_id: null, tester_id: byEmail['outsider@example.com']!.id })

    // Nothing was lost on the way, and nothing points at a row that is not there.
    expect(legacy.prepare('SELECT COUNT(*) AS value FROM tickets').get()).toEqual({ value: 3 })
    expect(legacy.prepare('SELECT COUNT(*) AS value FROM board_members').get()).toEqual({ value: 1 })
    expect(legacy.pragma('foreign_key_check')).toEqual([])

    // The columns it replaced are gone, so nothing can keep a second, diverging copy.
    const ticketColumns = (legacy.pragma('table_info(tickets)') as Array<{ name: string }>).map(column => column.name)
    expect(ticketColumns).not.toContain('author_email')
    expect(ticketColumns).not.toContain('author_first_name')
    expect(ticketColumns).not.toContain('assignee_email')

    legacy.close()
  })

  it('adds the per-board auto-author switch, on by default', async () => {
    const db = await import('../server/utils/db')
    const legacy = legacyDatabase()

    expect(db.ensureBoardAutoAuthor(legacy)).toBe(true)
    expect(db.ensureBoardAutoAuthor(legacy)).toBe(false)
    expect(legacy.prepare('SELECT auto_author FROM boards').get()).toEqual({ auto_author: 1 })
    legacy.close()
  })
})
