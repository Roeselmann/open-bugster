import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const VERSION = 'v1'
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32
const FALLBACK_SALT = 'open-bugster-secret-box'

export class SecretBoxError extends Error {}

let cachedKey: Buffer | null = null
let warnedAboutFallback = false

function decodeConfiguredKey(value: string): Buffer {
  const trimmed = value.trim()
  const buffer = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64')
  if (buffer.length !== KEY_LENGTH) {
    throw new SecretBoxError('BUGSTER_SECRET_KEY must decode to 32 bytes (base64 or hex).')
  }
  return buffer
}

// The dedicated key is preferred. Deriving from the mandatory session password keeps
// existing deployments working after an upgrade, at the price of tying stored keys to
// a value the operator might rotate — hence the warning.
function resolveKey(): Buffer {
  if (cachedKey) return cachedKey
  const configured = process.env.BUGSTER_SECRET_KEY?.trim()
  if (configured) {
    cachedKey = decodeConfiguredKey(configured)
    return cachedKey
  }
  const sessionPassword = process.env.NUXT_SESSION_PASSWORD?.trim()
  if (!sessionPassword) {
    throw new SecretBoxError('Set BUGSTER_SECRET_KEY (or NUXT_SESSION_PASSWORD) before storing App Store Connect keys.')
  }
  if (!warnedAboutFallback) {
    warnedAboutFallback = true
    console.warn('[open-bugster] BUGSTER_SECRET_KEY is not set. Stored App Store Connect keys are derived from NUXT_SESSION_PASSWORD and become unreadable if it changes.')
  }
  cachedKey = scryptSync(sessionPassword, FALLBACK_SALT, KEY_LENGTH)
  return cachedKey
}

export function resetSecretKeyCache() {
  cachedKey = null
  warnedAboutFallback = false
}

export function secretKeyAvailable(): boolean {
  try {
    resolveKey()
    return true
  } catch {
    return false
  }
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', resolveKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return `${VERSION}.${iv.toString('base64')}.${ciphertext.toString('base64')}`
}

export function decryptSecret(value: string): string {
  const [version, ivPart, payloadPart] = value.split('.')
  if (version !== VERSION || !ivPart || !payloadPart) throw new SecretBoxError('The stored secret has an unknown format.')
  const iv = Buffer.from(ivPart, 'base64')
  const payload = Buffer.from(payloadPart, 'base64')
  if (iv.length !== IV_LENGTH || payload.length <= TAG_LENGTH) throw new SecretBoxError('The stored secret is malformed.')
  const decipher = createDecipheriv('aes-256-gcm', resolveKey(), iv)
  decipher.setAuthTag(payload.subarray(payload.length - TAG_LENGTH))
  try {
    return Buffer.concat([decipher.update(payload.subarray(0, payload.length - TAG_LENGTH)), decipher.final()]).toString('utf8')
  } catch {
    throw new SecretBoxError('The stored secret could not be decrypted. Has BUGSTER_SECRET_KEY changed?')
  }
}
