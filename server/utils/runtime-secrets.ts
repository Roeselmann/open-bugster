import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * The two machine secrets — the session-cookie password and the key that encrypts stored
 * App Store Connect keys — are nothing an operator ever types or remembers, so a first
 * start generates whichever ones the environment does not provide and keeps them in
 * `secrets.json` next to the database. That puts them inside the data volume, where the
 * backup that holds the encrypted keys also holds the key that opens them.
 *
 * Resolution order per value: environment variable, then the file, then a fresh random
 * value. An environment value always wins and is never copied into the file, so an
 * operator who keeps secrets in `.env` or a secret manager leaves no second copy behind.
 *
 * One exception, for installations that predate the file: when NUXT_SESSION_PASSWORD is
 * set but BUGSTER_SECRET_KEY is not, no key is generated. The secret box then derives it
 * from the session password exactly as before, so stored keys remain readable.
 */

export interface RuntimeSecrets {
  sessionPassword: string
  /** Null when the legacy derivation from NUXT_SESSION_PASSWORD must stay in effect. */
  secretKey: string | null
  generated: Array<'NUXT_SESSION_PASSWORD' | 'BUGSTER_SECRET_KEY'>
  filePath: string
}

interface SecretsFile {
  sessionPassword?: string
  secretKey?: string
}

export function secretsFilePath(): string {
  const databasePath = process.env.DATABASE_PATH || './data/open-bugster.sqlite'
  return join(dirname(databasePath), 'secrets.json')
}

/**
 * A malformed file is an error, never a shrug: regenerating over it would sign every
 * session out and leave the stored App Store Connect keys permanently unreadable.
 */
function readSecretsFile(path: string): SecretsFile {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    throw new Error(`${path} is not valid JSON. Restore it from a backup or move it aside — regenerating would invalidate sessions and stored App Store Connect keys.`)
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${path} does not hold an object.`)
  const record = parsed as Record<string, unknown>
  const file: SecretsFile = {}
  if (typeof record.sessionPassword === 'string' && record.sessionPassword) file.sessionPassword = record.sessionPassword
  if (typeof record.secretKey === 'string' && record.secretKey) file.secretKey = record.secretKey
  return file
}

/** Written via a sibling temp file and rename, so a crash cannot leave half a secret. */
function writeSecretsFile(path: string, file: SecretsFile) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

export function ensureRuntimeSecrets(): RuntimeSecrets {
  const envSessionPassword = process.env.NUXT_SESSION_PASSWORD?.trim() || ''
  const envSecretKey = process.env.BUGSTER_SECRET_KEY?.trim() || ''
  const filePath = secretsFilePath()
  const file = readSecretsFile(filePath)
  const generated: RuntimeSecrets['generated'] = []

  let sessionPassword = envSessionPassword || file.sessionPassword || ''
  if (!sessionPassword) {
    sessionPassword = randomBytes(32).toString('base64')
    file.sessionPassword = sessionPassword
    generated.push('NUXT_SESSION_PASSWORD')
  }

  let secretKey: string | null = envSecretKey || file.secretKey || null
  if (!secretKey && !envSessionPassword) {
    secretKey = randomBytes(32).toString('base64')
    file.secretKey = secretKey
    generated.push('BUGSTER_SECRET_KEY')
  }

  if (generated.length > 0) writeSecretsFile(filePath, file)
  return { sessionPassword, secretKey, generated, filePath }
}
