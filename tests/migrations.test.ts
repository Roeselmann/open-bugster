import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { ensureBoardIntegrations, ensureSyncRunProvider, ensureTicketSourceJira } from '../server/utils/db'

/**
 * The migrations that generalise the import: run against hand-built tables of the previous
 * shape, because the database module itself always opens at the newest one.
 */
describe('the integration migrations', () => {
  it('moves the App Store Connect columns into board_integrations and drops them', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE boards (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL,
        asc_issuer_id TEXT NOT NULL DEFAULT '', asc_key_id TEXT NOT NULL DEFAULT '', asc_app_id TEXT NOT NULL DEFAULT '',
        asc_private_key TEXT, asc_key_filename TEXT, asc_key_uploaded_at TEXT,
        sync_limit INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL
      );
      INSERT INTO boards VALUES ('b1', 'Connected', 0, 'issuer', 'KEY123', '42', 'sealed-key', 'AuthKey_KEY123.p8', '2026-01-01T00:00:00.000Z', 100, '2026-01-01T00:00:00.000Z');
      INSERT INTO boards VALUES ('b2', 'Plain', 1, '', '', '', NULL, NULL, NULL, 100, '2026-01-01T00:00:00.000Z');
    `)

    expect(ensureBoardIntegrations(db)).toBe(true)

    const rows = db.prepare('SELECT board_id, provider, config, secret, secret_label, secret_updated_at FROM board_integrations ORDER BY board_id').all()
    expect(rows).toEqual([{
      board_id: 'b1', provider: 'testflight',
      config: JSON.stringify({ issuerId: 'issuer', keyId: 'KEY123', appId: '42' }),
      secret: 'sealed-key', secret_label: 'AuthKey_KEY123.p8', secret_updated_at: '2026-01-01T00:00:00.000Z'
    }])
    const columns = (db.pragma('table_info(boards)') as Array<{ name: string }>).map(column => column.name)
    expect(columns).toEqual(['id', 'name', 'position', 'sync_limit', 'created_at'])
    // Idempotent: a second start finds nothing to move.
    expect(ensureBoardIntegrations(db)).toBe(false)
  })

  it('gives every sync run a provider, TestFlight for the ones that predate the choice', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY);
      CREATE TABLE sync_runs (id TEXT PRIMARY KEY, board_id TEXT REFERENCES boards(id), started_at TEXT NOT NULL, status TEXT NOT NULL);
      INSERT INTO sync_runs VALUES ('r1', NULL, '2026-01-01T00:00:00.000Z', 'success');
    `)
    expect(ensureSyncRunProvider(db)).toBe(true)
    expect(db.prepare('SELECT provider FROM sync_runs').get()).toEqual({ provider: 'testflight' })
    expect(ensureSyncRunProvider(db)).toBe(false)
  })

  it('widens the source check on tickets and keeps rows, columns and indexes', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE boards (id TEXT PRIMARY KEY);
      CREATE TABLE lanes (id TEXT PRIMARY KEY);
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY,
        ticket_number INTEGER NOT NULL UNIQUE,
        board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        lane_id TEXT NOT NULL REFERENCES lanes(id),
        title TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('manual', 'testflight_screenshot', 'testflight_crash')),
        external_id TEXT,
        created_at TEXT NOT NULL,
        later_added_column TEXT
      );
      CREATE UNIQUE INDEX idx_tickets_external ON tickets(board_id, external_id);
      CREATE TABLE attachments (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE);
      INSERT INTO boards VALUES ('b1'); INSERT INTO lanes VALUES ('l1');
      INSERT INTO tickets VALUES ('t1', 1, 'b1', 'l1', 'Kept', 'manual', NULL, '2026-01-01T00:00:00.000Z', 'kept too');
      INSERT INTO attachments VALUES ('a1', 't1');
    `)
    expect(() => db.prepare("INSERT INTO tickets (id, ticket_number, board_id, lane_id, title, source, created_at) VALUES ('t2', 2, 'b1', 'l1', 'Jira', 'jira_issue', '2026-01-01T00:00:00.000Z')").run()).toThrow(/CHECK/)

    expect(ensureTicketSourceJira(db)).toBe(true)

    expect(db.prepare('SELECT title, later_added_column FROM tickets WHERE id = ?').get('t1')).toEqual({ title: 'Kept', later_added_column: 'kept too' })
    db.prepare("INSERT INTO tickets (id, ticket_number, board_id, lane_id, title, source, external_id, created_at) VALUES ('t2', 2, 'b1', 'l1', 'Jira', 'jira_issue', '10001', '2026-01-01T00:00:00.000Z')").run()
    expect(() => db.prepare("INSERT INTO tickets (id, ticket_number, board_id, lane_id, title, source, external_id, created_at) VALUES ('t3', 3, 'b1', 'l1', 'Dup', 'jira_issue', '10001', '2026-01-01T00:00:00.000Z')").run()).toThrow(/UNIQUE/)
    expect((db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'tickets' AND sql IS NOT NULL").all() as Array<{ name: string }>).map(row => row.name)).toContain('idx_tickets_external')
    expect(db.prepare('SELECT COUNT(*) AS value FROM attachments').get()).toEqual({ value: 1 })
    expect(ensureTicketSourceJira(db)).toBe(false)
  })
})
