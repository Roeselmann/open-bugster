import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'

/**
 * Break-glass access recovery, run on the server that holds the database.
 *
 * The owner is normally seeded from the bootstrap variables on the very first start, and
 * they are ignored from then on — so a forgotten password cannot be fixed by editing
 * `.env`. This restores an account directly, and creates the owner when the first start
 * never managed to seed one.
 */

const [email, password] = process.argv.slice(2)

if (!email || !password) {
  console.error('Usage: npm run owner:reset -- <email> "<new-password>"')
  process.exit(1)
}
if (password.length < 12) {
  console.error('Please provide a password with at least 12 characters.')
  process.exit(1)
}

// A plain Node script gets none of Nuxt's .env loading, and inside Docker the variables
// are already in the environment. Read the file only to fill in what is missing.
function loadEnvFile(path = '.env') {
  let contents
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key] !== undefined) continue
    process.env[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}

loadEnvFile()

function hashPassword(value) {
  const salt = randomBytes(16).toString('hex')
  return `scrypt$${salt}$${scryptSync(value, salt, 64).toString('hex')}`
}

const path = process.env.DATABASE_PATH || './data/open-bugster.sqlite'
let db
try {
  db = new Database(path, { fileMustExist: true })
} catch {
  console.error(`No database at ${path}. Set DATABASE_PATH, or start Open-Bugster once to create it.`)
  process.exit(1)
}
db.pragma('foreign_keys = ON')

const normalized = email.trim().toLowerCase()
const existing = db.prepare('SELECT id, email, role FROM users WHERE email = ? COLLATE NOCASE').get(normalized)
const total = db.prepare('SELECT COUNT(*) AS value FROM users').get().value
const now = new Date().toISOString()

if (existing) {
  // Activates the account and retires every session it still has open, exactly as a
  // password change through the app does.
  db.prepare(`
    UPDATE users
    SET password_hash = ?, status = 'active', invite_token_hash = NULL, invite_expires_at = NULL,
        session_version = session_version + 1
    WHERE id = ?
  `).run(hashPassword(password), existing.id)
  console.log(`Password reset for ${existing.email} (${existing.role}). Other sessions have been signed out.`)
} else if (total === 0) {
  // The first start never seeded an owner — create one now, with every board.
  const id = randomUUID()
  db.transaction(() => {
    db.prepare(`
      INSERT INTO users (id, email, first_name, last_name, password_hash, role, status, created_at)
      VALUES (?, ?, ?, '', ?, 'owner', 'active', ?)
    `).run(id, normalized, process.env.APP_ADMIN_FIRST_NAME?.trim() || 'Admin', hashPassword(password), now)
    const boards = db.prepare('SELECT id FROM boards').all()
    const addMember = db.prepare("INSERT OR IGNORE INTO board_members (board_id, user_id, role, added_at) VALUES (?, ?, 'admin', ?)")
    for (const board of boards) addMember.run(board.id, id, now)
    console.log(`Created the owner account ${normalized} with admin access to ${boards.length} board(s).`)
  })()
} else {
  const known = db.prepare('SELECT email FROM users ORDER BY email').all().map(row => `  ${row.email}`)
  console.error(`No account with the address ${normalized}. Existing accounts:\n${known.join('\n')}`)
  process.exit(1)
}

db.close()
