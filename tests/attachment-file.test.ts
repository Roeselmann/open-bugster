import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The one piece of the download path that decides which file leaves the server.
 *
 * A stored `relative_path` is data — written by an upload today, but a row all the same —
 * and everything below is what stops it from naming something outside the attachments
 * directory. Worth its own test because both download surfaces now lean on it.
 */
describe('resolving an attachment to a file on disk', () => {
  let resolveAttachmentFile: typeof import('../server/utils/attachment-file').resolveAttachmentFile
  let root = ''
  let outside = ''

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-files-'))
    root = join(directory, 'attachments')
    await mkdir(join(root, 'tkt_1'), { recursive: true })
    await writeFile(join(root, 'tkt_1', 'shot.png'), 'pretend png')

    // A file the attachments directory has no business handing out.
    outside = join(directory, 'secrets.env')
    await writeFile(outside, 'BUGSTER_SECRET_KEY=nope')

    process.env.ATTACHMENTS_PATH = root
    ;({ resolveAttachmentFile } = await import('../server/utils/attachment-file'))
  })

  it('resolves a path inside the attachments directory', async () => {
    await expect(resolveAttachmentFile('tkt_1/shot.png')).resolves.toContain('shot.png')
  })

  it('refuses to climb out with ..', async () => {
    await expect(resolveAttachmentFile('../secrets.env')).rejects.toMatchObject({ statusCode: 400 })
    await expect(resolveAttachmentFile('tkt_1/../../secrets.env')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('refuses an absolute path outright', async () => {
    await expect(resolveAttachmentFile(outside)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('refuses a symlink that points outside, however innocent the path looks', async () => {
    // The check before realpath passes here — this is the one the second check exists for.
    await symlink(outside, join(root, 'tkt_1', 'escape.png'))
    await expect(resolveAttachmentFile('tkt_1/escape.png')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('answers 404 for a row whose file is gone', async () => {
    await expect(resolveAttachmentFile('tkt_1/never-written.png')).rejects.toMatchObject({ statusCode: 404 })
  })
})
