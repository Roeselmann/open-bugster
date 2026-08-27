import { describe, expect, it } from 'vitest'
import { generateKeyPair, exportPKCS8, decodeJwt, decodeProtectedHeader } from 'jose'
import { createAppleToken } from '../server/utils/app-store-connect'

describe('App Store Connect JWT', () => {
  it('creates a short-lived ES256 team token', async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true })
    const token = await createAppleToken({ issuerId: 'issuer-id', keyId: 'KEY123', privateKeyPem: await exportPKCS8(privateKey) }, 1_800_000_000)
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' })
    expect(decodeJwt(token)).toMatchObject({ iss: 'issuer-id', aud: 'appstoreconnect-v1', iat: 1_800_000_000, exp: 1_800_001_140 })
  })

  it('rejects a key that is not a usable ES256 key', async () => {
    await expect(createAppleToken({ issuerId: 'issuer-id', keyId: 'KEY123', privateKeyPem: 'not a key' })).rejects.toThrow(/could not be read or processed/)
  })
})
