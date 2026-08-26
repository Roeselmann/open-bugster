import { describe, expect, it } from 'vitest'
import { scryptSync } from 'node:crypto'
import { verifyStoredPassword } from '../server/utils/password'

describe('password verification', () => {
  it('verifies scrypt hashes without accepting malformed values', () => {
    const password = 'correct horse battery staple'
    const salt = '0123456789abcdef0123456789abcdef'
    const stored = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`
    expect(verifyStoredPassword(password, stored)).toBe(true)
    expect(verifyStoredPassword('wrong password', stored)).toBe(false)
    expect(verifyStoredPassword(password, 'invalid')).toBe(false)
  })
})
