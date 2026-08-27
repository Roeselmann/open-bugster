import { basename } from 'node:path'
import { importPKCS8 } from 'jose'

export const MAX_PRIVATE_KEY_SIZE = 16 * 1024

export class PrivateKeyPolicyError extends Error {}

export function safeKeyFilename(value: string) {
  const cleaned = basename(value).replace(/[^a-zA-Z0-9._-]/g, '_').trim()
  return (cleaned || 'AuthKey.p8').slice(0, 120)
}

/**
 * Accepts only a PKCS#8 EC key that App Store Connect could actually sign with, so a
 * wrong file is rejected at upload time instead of at the next sync.
 */
export async function validatePrivateKey(input: { filename: string; data: Buffer }) {
  const filename = safeKeyFilename(input.filename)
  if (!filename.toLowerCase().endsWith('.p8')) throw new PrivateKeyPolicyError('The App Store Connect key must be a .p8 file.')
  if (!input.data.length) throw new PrivateKeyPolicyError(`“${filename}” is empty.`)
  if (input.data.length > MAX_PRIVATE_KEY_SIZE) throw new PrivateKeyPolicyError(`“${filename}” is larger than 16 KB and cannot be a .p8 key.`)

  const pem = input.data.toString('utf8').replace(/\r\n/g, '\n').trim()
  if (!pem.startsWith('-----BEGIN PRIVATE KEY-----')) {
    throw new PrivateKeyPolicyError('The file does not look like a PKCS#8 private key. Upload the .p8 exactly as downloaded from App Store Connect.')
  }
  try {
    await importPKCS8(pem, 'ES256')
  } catch {
    throw new PrivateKeyPolicyError('The private key could not be read as an ES256 key.')
  }
  return { filename, pem }
}
