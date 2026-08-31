import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { verifyStoredPassword } from '../server/utils/password'

/**
 * Each test boots a fresh database module against its own file, because the bootstrap
 * variables are only read while the very first `getDb()` runs.
 */
async function freshInstance() {
  vi.resetModules()
  const directory = await mkdtemp(join(tmpdir(), 'open-bugster-owner-'))
  process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
  const db = await import('../server/utils/db')
  db.listBoards() // touches getDb(), which seeds
  return new Database(process.env.DATABASE_PATH, { readonly: true })
}

function ownerRow(db: Database.Database) {
  return db.prepare("SELECT email, role, status, password_hash FROM users WHERE role = 'owner'").get() as
    | { email: string; role: string; status: string; password_hash: string }
    | undefined
}

describe('owner seeding from the environment', () => {
  beforeEach(() => {
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    process.env.APP_ADMIN_EMAIL = 'ada@example.com'
    delete process.env.APP_PASSWORD_HASH
    delete process.env.APP_ADMIN_PASSWORD
  })

  it('seeds the owner from a plain APP_ADMIN_PASSWORD, hashed at that moment', async () => {
    process.env.APP_ADMIN_PASSWORD = 'a-long-first-password'
    const raw = await freshInstance()
    const owner = ownerRow(raw)
    expect(owner).toMatchObject({ email: 'ada@example.com', role: 'owner', status: 'active' })
    expect(owner!.password_hash.startsWith('scrypt$')).toBe(true)
    expect(verifyStoredPassword('a-long-first-password', owner!.password_hash)).toBe(true)
  })

  it('lets APP_PASSWORD_HASH win when both are set', async () => {
    process.env.APP_PASSWORD_HASH = 'scrypt$abc$def'
    process.env.APP_ADMIN_PASSWORD = 'a-long-first-password'
    const raw = await freshInstance()
    expect(ownerRow(raw)!.password_hash).toBe('scrypt$abc$def')
  })

  it('ignores a password shorter than 12 characters and seeds nobody', async () => {
    process.env.APP_ADMIN_PASSWORD = 'too-short'
    const raw = await freshInstance()
    expect(ownerRow(raw)).toBeUndefined()
  })
})
