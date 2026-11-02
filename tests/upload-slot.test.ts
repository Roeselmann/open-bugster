import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One-time upload addresses: what `attachment.uploadUrl` hands out and what spending one
 * acts as. The HTTP handler on top is thin and is exercised against a running instance; the
 * guarantees worth pinning live here.
 */
describe('upload addresses', () => {
  let db: typeof import('../server/utils/db')
  let ops: typeof import('../server/operations')
  let token: typeof import('../server/utils/token')
  let slots: typeof import('../server/utils/upload-slot')
  let audit: typeof import('../server/utils/audit')

  let ownerId = ''
  let boardId = ''
  let laneId = ''

  const statusOf = async (promise: Promise<unknown>) => {
    try {
      await promise
      return 200
    } catch (error) {
      return (error as { statusCode?: number }).statusCode ?? 500
    }
  }

  const agent = (scopes: Array<'read' | 'write'> = ['write']) => {
    const minted = token.createApiToken({ principalId: ownerId, name: 'agent', agentLabel: 'Claude Code', scopes })
    return { minted, actor: token.resolveToken(minted.token, 'mcp')! }
  }

  const newTicket = async (actor: import('../server/utils/actor').Actor) => {
    const { ticket } = await ops.run(ops.ticketCreate, actor, { boardId, laneId, title: 'Needs a screenshot' }) as { ticket: { id: string } }
    return ticket.id
  }

  const secretOf = (path: string) => path.replace('/api/uploads/', '')

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-upload-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.ATTACHMENTS_PATH = join(directory, 'attachments')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    process.env.APP_PASSWORD_HASH = 'scrypt$abc$def'
    process.env.APP_ADMIN_EMAIL = 'owner@example.com'
    process.env.APP_ADMIN_FIRST_NAME = 'Grace'
    process.env.APP_ADMIN_LAST_NAME = 'Hopper'

    db = await import('../server/utils/db')
    ops = await import('../server/operations')
    token = await import('../server/utils/token')
    slots = await import('../server/utils/upload-slot')
    audit = await import('../server/utils/audit')

    ownerId = db.findUserByEmail('owner@example.com')!.id
    const board = db.listBoards()[0]!
    boardId = board.id
    laneId = board.lanes[0]!.id
  })

  it('hands out an address that opens once and acts as the token that asked', async () => {
    const { actor } = agent()
    const ticketId = await newTicket(actor)
    const { upload } = await ops.run(ops.attachmentUploadUrl, actor, { ticketId }) as { upload: { path: string; field: string; expiresInMinutes: number } }
    expect(upload).toMatchObject({ field: 'file', expiresInMinutes: 10 })
    expect(upload.path).toMatch(/^\/api\/uploads\/[\w-]{43}$/)

    const slot = slots.findOpenUploadSlot(secretOf(upload.path))!
    expect(slot).toMatchObject({ ticketId, tokenId: actor.tokenId, channel: 'mcp' })
    expect(slots.actorForUploadSlot(slot)).toMatchObject({ principalId: ownerId, agentId: 'Claude Code', tokenId: actor.tokenId })

    expect(slots.claimUploadSlot(slot.id)).toBe(true)
    expect(slots.claimUploadSlot(slot.id)).toBe(false)
    expect(slots.findOpenUploadSlot(secretOf(upload.path))).toBeNull()
  })

  it('keeps the secret out of the database and the audit log', async () => {
    const { actor } = agent()
    const ticketId = await newTicket(actor)
    const { upload } = await ops.run(ops.attachmentUploadUrl, actor, { ticketId, filename: 'crash.log' }) as { upload: { path: string } }
    const secret = secretOf(upload.path)
    const stored = db.getDb().prepare('SELECT * FROM upload_slots WHERE ticket_id = ?').get(ticketId) as Record<string, unknown>
    expect(JSON.stringify(stored)).not.toContain(secret)
    expect(stored.filename).toBe('crash.log')
    const entry = audit.listAudit({ operation: 'attachment.uploadUrl' })[0]!
    expect(entry).toMatchObject({ targetId: ticketId, changes: { filename: 'crash.log' } })
    expect(JSON.stringify(entry)).not.toContain(secret)
  })

  it('refuses a read-only token, as any other attachment write', async () => {
    const writer = agent().actor
    const ticketId = await newTicket(writer)
    expect(await statusOf(ops.run(ops.attachmentUploadUrl, agent(['read']).actor, { ticketId }))).toBe(403)
  })

  it('refuses an archived ticket', async () => {
    const { actor } = agent()
    const ticketId = await newTicket(actor)
    await ops.run(ops.ticketArchive, actor, { ticketId })
    // Access resolution already treats an archived ticket as gone from the board.
    expect(await statusOf(ops.run(ops.attachmentUploadUrl, actor, { ticketId }))).toBe(404)
  })

  it('dies with the token it was issued through', async () => {
    const { minted, actor } = agent()
    const ticketId = await newTicket(actor)
    const { upload } = await ops.run(ops.attachmentUploadUrl, actor, { ticketId }) as { upload: { path: string } }
    token.revokeApiToken(minted.id)
    const slot = slots.findOpenUploadSlot(secretOf(upload.path))!
    expect(slots.actorForUploadSlot(slot)).toBeNull()
  })

  it('stops opening once it has expired', async () => {
    const { actor } = agent()
    const ticketId = await newTicket(actor)
    const { upload } = await ops.run(ops.attachmentUploadUrl, actor, { ticketId }) as { upload: { path: string } }
    db.getDb().prepare('UPDATE upload_slots SET expires_at = ? WHERE ticket_id = ?').run(new Date(Date.now() - 1000).toISOString(), ticketId)
    expect(slots.findOpenUploadSlot(secretOf(upload.path))).toBeNull()
    expect(slots.findOpenUploadSlot('not-a-secret-anybody-issued')).toBeNull()
  })

  it('turns an upload through the address into an ordinary attachment', async () => {
    const { actor } = agent()
    const ticketId = await newTicket(actor)
    const { upload } = await ops.run(ops.attachmentUploadUrl, actor, { ticketId }) as { upload: { path: string } }
    const slot = slots.findOpenUploadSlot(secretOf(upload.path))!
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')])
    // What the handler does once the slot is spent.
    const { attachment } = await ops.run(ops.attachmentAdd, slots.actorForUploadSlot(slot)!, {
      ticketId: slot.ticketId, filename: 'shot.png', content: png.toString('base64')
    }) as { attachment: { id: string } }
    expect(audit.listAudit({ operation: 'attachment.add' })[0]).toMatchObject({ targetId: attachment.id, agentId: 'Claude Code', channel: 'mcp' })
  })

  it('is offered to an agent with the command that spends it', async () => {
    const { registerTools } = await import('../server/mcp/tools')
    const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }> }>>()
    const server = { registerTool: (name: string, _config: unknown, handler: never) => tools.set(name, handler) }
    const { actor } = agent()
    registerTools(server as never, actor, { origin: 'https://bugs.example.com' })
    const ticketId = await newTicket(actor)
    const result = JSON.parse((await tools.get('create_upload_url')!({ ticketId })).content[0]!.text!)
    expect(result.url).toMatch(/^https:\/\/bugs\.example\.com\/api\/uploads\/[\w-]{43}$/)
    expect(result.command).toBe(`curl -sS -F 'file=@<path to the file>' '${result.url}'`)
  })
})
