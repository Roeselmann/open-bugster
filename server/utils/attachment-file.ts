import { realpath, stat } from 'node:fs/promises'
import { createError } from 'h3'
import { isAbsolute, resolve, sep } from 'node:path'
import { getServerConfig } from './config'

/**
 * The absolute path an attachment's stored `relative_path` points at.
 *
 * Shared by the two download surfaces rather than written twice, because these are exactly
 * the checks that drift apart once copied: a stored path is data, and data that reaches
 * `resolve()` decides which file leaves the server. The candidate is compared against the
 * attachments root both before and after `realpath`, so neither a `..` segment in the row
 * nor a symlink planted inside the directory can point outside it.
 *
 * Throws the same 404 for a row whose file is gone as for one that never existed: which of
 * the two it is says something about the instance and nothing the caller can act on.
 */
export async function resolveAttachmentFile(relativePath: string): Promise<string> {
  const config = getServerConfig()
  const root = await realpath(resolve(config.attachmentsPath)).catch(() => resolve(config.attachmentsPath))
  const candidate = resolve(root, relativePath)
  if (isAbsolute(relativePath) || (candidate !== root && !candidate.startsWith(`${root}${sep}`))) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid file path.' })
  }
  const actual = await realpath(candidate).catch(() => null)
  if (!actual || (actual !== root && !actual.startsWith(`${root}${sep}`))) {
    throw createError({ statusCode: 404, statusMessage: 'File not found.' })
  }
  await stat(actual).catch(() => { throw createError({ statusCode: 404, statusMessage: 'File not found.' }) })
  return actual
}
