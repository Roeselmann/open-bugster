import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export function verifyStoredPassword(password: string, stored: string): boolean {
  const [algorithm, salt, expectedHex] = stored.split('$')
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false
  try {
    const expected = Buffer.from(expectedHex, 'hex')
    const actual = scryptSync(password, salt, expected.length)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/**
 * Produces the same `scrypt$salt$hex` string the bootstrap script writes into `.env`, so
 * a password set in the app and one hashed on the command line verify identically.
 */
export function hashStoredPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`
}
