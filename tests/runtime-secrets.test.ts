import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRuntimeSecrets, secretsFilePath } from '../server/utils/runtime-secrets'

describe('runtime secrets', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'open-bugster-secrets-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    delete process.env.NUXT_SESSION_PASSWORD
    delete process.env.BUGSTER_SECRET_KEY
  })

  it('generates both secrets on a bare first start and reads them back afterwards', () => {
    const first = ensureRuntimeSecrets()
    expect(first.generated).toEqual(['NUXT_SESSION_PASSWORD', 'BUGSTER_SECRET_KEY'])
    expect(Buffer.from(first.sessionPassword, 'base64')).toHaveLength(32)
    expect(Buffer.from(first.secretKey!, 'base64')).toHaveLength(32)
    expect(first.filePath).toBe(join(directory, 'secrets.json'))

    const second = ensureRuntimeSecrets()
    expect(second.generated).toEqual([])
    expect(second.sessionPassword).toBe(first.sessionPassword)
    expect(second.secretKey).toBe(first.secretKey)
  })

  it('prefers environment values and never copies them into the file', () => {
    process.env.NUXT_SESSION_PASSWORD = 'session-from-env'
    process.env.BUGSTER_SECRET_KEY = 'key-from-env'
    const secrets = ensureRuntimeSecrets()
    expect(secrets).toMatchObject({ sessionPassword: 'session-from-env', secretKey: 'key-from-env', generated: [] })
    expect(existsSync(secretsFilePath())).toBe(false)
  })

  it('keeps the legacy derivation intact: a session password from the environment suppresses key generation', () => {
    process.env.NUXT_SESSION_PASSWORD = 'operator-managed'
    const secrets = ensureRuntimeSecrets()
    expect(secrets.sessionPassword).toBe('operator-managed')
    expect(secrets.secretKey).toBeNull()
    expect(secrets.generated).toEqual([])
    expect(existsSync(secretsFilePath())).toBe(false)
  })

  it('fills in only what the file is missing and keeps what it has', async () => {
    await writeFile(secretsFilePath(), JSON.stringify({ sessionPassword: 'kept-session' }))
    const secrets = ensureRuntimeSecrets()
    expect(secrets.sessionPassword).toBe('kept-session')
    expect(secrets.generated).toEqual(['BUGSTER_SECRET_KEY'])
    const stored = JSON.parse(await readFile(secretsFilePath(), 'utf8'))
    expect(stored).toEqual({ sessionPassword: 'kept-session', secretKey: secrets.secretKey })
  })

  it('still uses a stored key when the operator later moves the session password into the environment', async () => {
    const first = ensureRuntimeSecrets()
    process.env.NUXT_SESSION_PASSWORD = 'rotated-later'
    const second = ensureRuntimeSecrets()
    expect(second.sessionPassword).toBe('rotated-later')
    expect(second.secretKey).toBe(first.secretKey)
  })

  it('refuses to run over a corrupt file instead of regenerating', async () => {
    await writeFile(secretsFilePath(), 'not json {')
    expect(() => ensureRuntimeSecrets()).toThrow(/not valid JSON/)
  })
})
