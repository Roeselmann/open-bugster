import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair, exportPKCS8, decodeJwt, decodeProtectedHeader } from 'jose'
import { createAppleToken } from '../server/utils/app-store-connect'

describe('App Store Connect JWT', () => {
  let directory = ''

  afterAll(async () => {
    if (directory) await import('node:fs/promises').then(fs => fs.rm(directory, { recursive: true, force: true }))
  })

  it('creates a short-lived ES256 team token', async () => {
    directory = await mkdtemp(join(tmpdir(), 'open-bugster-jwt-'))
    const { privateKey } = await generateKeyPair('ES256', { extractable: true })
    const keyPath = join(directory, 'AuthKey.p8')
    await writeFile(keyPath, await exportPKCS8(privateKey))
    const token = await createAppleToken({ issuerId: 'issuer-id', keyId: 'KEY123', privateKeyPath: keyPath }, 1_800_000_000)
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' })
    expect(decodeJwt(token)).toMatchObject({ iss: 'issuer-id', aud: 'appstoreconnect-v1', iat: 1_800_000_000, exp: 1_800_001_140 })
  })
})
