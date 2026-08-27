import { beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { decryptSecret, encryptSecret, resetSecretKeyCache, SecretBoxError } from '../server/utils/secret-box'

describe('secret box', () => {
  beforeEach(() => {
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    resetSecretKeyCache()
  })

  it('round-trips a private key', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIGH\n-----END PRIVATE KEY-----\n'
    const sealed = encryptSecret(pem)
    expect(sealed).not.toContain('BEGIN PRIVATE KEY')
    expect(sealed.startsWith('v1.')).toBe(true)
    expect(decryptSecret(sealed)).toBe(pem)
  })

  it('produces a different ciphertext for the same input', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
  })

  it('rejects tampered ciphertext', () => {
    const [version, iv, payload] = encryptSecret('secret').split('.')
    const bytes = Buffer.from(payload!, 'base64')
    bytes[0] = bytes[0]! ^ 0xff
    expect(() => decryptSecret(`${version}.${iv}.${bytes.toString('base64')}`)).toThrow(SecretBoxError)
  })

  it('rejects a secret sealed with a different key', () => {
    const sealed = encryptSecret('secret')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    resetSecretKeyCache()
    expect(() => decryptSecret(sealed)).toThrow(SecretBoxError)
  })

  it('falls back to the session password when no dedicated key is set', () => {
    delete process.env.BUGSTER_SECRET_KEY
    process.env.NUXT_SESSION_PASSWORD = 'a-long-session-password-for-testing'
    resetSecretKeyCache()
    expect(decryptSecret(encryptSecret('secret'))).toBe('secret')
  })

  it('rejects a malformed key length', () => {
    process.env.BUGSTER_SECRET_KEY = 'too-short'
    resetSecretKeyCache()
    expect(() => encryptSecret('secret')).toThrow(SecretBoxError)
  })
})
