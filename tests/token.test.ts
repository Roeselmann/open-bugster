import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('service identities and API tokens', () => {
  let db: typeof import('../server/utils/db')
  let token: typeof import('../server/utils/token')
  let access: typeof import('../server/utils/access')
  let actorModule: typeof import('../server/utils/actor')
  let ops: typeof import('../server/operations')

  let boardId = ''
  let otherBoardId = ''
  let laneId = ''
  const people: Record<string, string> = {}

  const actorOf = (who: string) => actorModule.actorFor(db.findUser(people[who]!)!)
  const statusOf = async (promise: Promise<unknown>) => {
    try {
      await promise
      return 200
    } catch (error) {
      return (error as { statusCode?: number }).statusCode ?? 500
    }
  }
  const sync = (run: () => unknown) => {
    try {
      run()
      return 200
    } catch (error) {
      return (error as { statusCode?: number }).statusCode ?? 500
    }
  }

  /** Mints a token for somebody and hands back the actor it resolves to. */
  const actorForToken = (who: string, options: Partial<Parameters<typeof token.createApiToken>[0]> = {}) => {
    const minted = token.createApiToken({
      principalId: people[who]!,
      name: options.name ?? 'test token',
      scopes: options.scopes ?? ['read'],
      ...options
    })
    return { minted, actor: token.resolveToken(minted.token, 'api') }
  }

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-token-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.ATTACHMENTS_PATH = join(directory, 'attachments')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    process.env.APP_PASSWORD_HASH = 'scrypt$abc$def'
    process.env.APP_ADMIN_EMAIL = 'owner@example.com'
    process.env.APP_ADMIN_FIRST_NAME = 'Grace'
    process.env.APP_ADMIN_LAST_NAME = 'Hopper'

    db = await import('../server/utils/db')
    token = await import('../server/utils/token')
    access = await import('../server/utils/access')
    actorModule = await import('../server/utils/actor')
    ops = await import('../server/operations')

    people.owner = db.listUsers()[0]!.id
    for (const who of ['editor', 'viewer']) {
      people[who] = db.createUser({ email: `${who}@example.com`, firstName: who, lastName: 'T', role: 'member' }).id
      db.updateUser(people[who]!, { status: 'active' })
    }
    const board = db.listBoards()[0]!
    boardId = board.id
    laneId = board.lanes.find(lane => !lane.isImport)!.id
    otherBoardId = db.createBoard('Second board').id
    db.setBoardMember(boardId, people.editor!, 'editor')
    db.setBoardMember(boardId, people.viewer!, 'viewer')
    db.setBoardMember(otherBoardId, people.editor!, 'editor')
  })

  describe('service identities', () => {
    it('opens a principal that cannot sign in but holds roles like anyone', () => {
      const bot = db.createServiceIdentity('Release Bot')
      expect(bot).toMatchObject({ email: null, passwordHash: null, status: 'active', role: 'member' })

      db.setBoardMember(boardId, bot.id, 'editor')
      expect(db.boardRoleFor(boardId, bot.id)).toBe('editor')

      // It appears in the history as itself, and is marked so the UI never mistakes it
      // for a colleague.
      const person = db.personById(bot.id)!
      expect(person).toMatchObject({ firstName: 'Release Bot', isAccount: false, isService: true })
      people.bot = bot.id
    })

    it('is not offered as somebody to invite or assign', () => {
      expect(db.listUsers().map(user => user.id)).not.toContain(people.bot)
      expect(db.listServiceIdentities().map(service => service.id)).toContain(people.bot)
    })
  })

  describe('minting and resolving', () => {
    it('returns a prefixed token once and stores only a hash', () => {
      const { minted } = actorForToken('editor', { name: 'CI' })
      expect(minted.token.startsWith('bgs_')).toBe(true)

      const stored = db.getDb().prepare('SELECT token_hash FROM api_tokens WHERE id = ?').get(minted.id) as { token_hash: string }
      expect(stored.token_hash).not.toContain(minted.token)
      expect(stored.token_hash).toBe(token.hashToken(minted.token.slice(`bgs_${minted.id}_`.length)))
    })

    it('resolves to its principal, carrying the agent label as provenance', () => {
      const { actor } = actorForToken('editor', { agentLabel: 'n8n prod', scopes: ['write'] })
      expect(actor).toMatchObject({ principalId: people.editor, agentId: 'n8n prod', channel: 'api' })
      expect(actor!.tokenId).toBeTruthy()
    })

    it('refuses anything malformed, unknown, revoked or expired — all the same way', () => {
      expect(token.resolveToken('', 'api')).toBeNull()
      expect(token.resolveToken('not-a-token', 'api')).toBeNull()
      expect(token.resolveToken('bgs_missing_secret', 'api')).toBeNull()

      const { minted } = actorForToken('editor')
      // The right id with the wrong secret is no better than a guess.
      expect(token.resolveToken(`bgs_${minted.id}_wrongsecret`, 'api')).toBeNull()

      token.revokeApiToken(minted.id)
      expect(token.resolveToken(minted.token, 'api')).toBeNull()

      const expired = token.createApiToken({
        principalId: people.editor!, name: 'stale', scopes: ['read'],
        expiresAt: new Date(Date.now() - 1000).toISOString()
      })
      expect(token.resolveToken(expired.token, 'api')).toBeNull()
    })

    it('dies with its principal, without being revoked one by one', () => {
      const person = db.createUser({ email: 'leaver@example.com', firstName: 'L', lastName: 'R', role: 'member' })
      db.updateUser(person.id, { status: 'active' })
      const minted = token.createApiToken({ principalId: person.id, name: 'theirs', scopes: ['read'] })
      expect(token.resolveToken(minted.token, 'api')).not.toBeNull()

      db.updateUser(person.id, { status: 'disabled' })
      expect(token.resolveToken(minted.token, 'api')).toBeNull()
    })

    it('records when it was last used', () => {
      // Minted directly, because resolving is what sets the timestamp being asserted on.
      const minted = token.createApiToken({ principalId: people.editor!, name: 'unused', scopes: ['read'] })
      expect(token.findApiToken(minted.id)!.lastUsedAt).toBeNull()
      token.resolveToken(minted.token, 'api')
      expect(token.findApiToken(minted.id)!.lastUsedAt).toBeTruthy()
    })
  })

  /**
   * The security property the whole design rests on. A token is a ceiling on what its
   * principal could already do, never a grant — so no combination of scopes turns somebody
   * into something they are not.
   */
  describe('scopes are a ceiling, never a grant', () => {
    it('caps a role down but never up', () => {
      // An editor's read-only token is a viewer.
      const readOnly = actorForToken('editor', { scopes: ['read'] }).actor!
      expect(access.requireBoardAccess(readOnly, boardId).role).toBe('viewer')
      expect(sync(() => access.requireBoardAccess(readOnly, boardId, 'editor'))).toBe(403)

      // A viewer's write token is still a viewer.
      const overreaching = actorForToken('viewer', { scopes: ['write', 'admin'] }).actor!
      expect(access.requireBoardAccess(overreaching, boardId).role).toBe('viewer')
      expect(sync(() => access.requireBoardAccess(overreaching, boardId, 'editor'))).toBe(403)

      // And an editor's write token is exactly an editor, not an admin.
      const writer = actorForToken('editor', { scopes: ['write'] }).actor!
      expect(access.requireBoardAccess(writer, boardId).role).toBe('editor')
      expect(sync(() => access.requireBoardAccess(writer, boardId, 'admin'))).toBe(403)
    })

    it('keeps a board-pinned token out of every other board, as a 404', () => {
      const pinned = actorForToken('editor', { scopes: ['write'], boardId }).actor!
      expect(sync(() => access.requireBoardAccess(pinned, boardId, 'editor'))).toBe(200)
      // The same answer a non-member gets: a 403 would confirm the other board exists.
      expect(sync(() => access.requireBoardAccess(pinned, otherBoardId))).toBe(404)
    })

    it('will not let an owner’s read-only token administer the instance', () => {
      const readOnly = actorForToken('owner', { scopes: ['read'] }).actor!
      expect(sync(() => access.requireInstanceAdmin(readOnly))).toBe(403)

      const full = actorForToken('owner', { scopes: ['admin'] }).actor!
      expect(sync(() => access.requireInstanceAdmin(full))).toBe(200)
    })

    it('will not let a board-pinned token administer the instance either', () => {
      const pinned = actorForToken('owner', { scopes: ['admin'], boardId }).actor!
      expect(sync(() => access.requireInstanceAdmin(pinned))).toBe(403)
    })

    it('leaves a browser session capped by nothing but the person behind it', () => {
      const session = actorOf('editor')
      expect(session.scopes).toBeNull()
      expect(access.requireBoardAccess(session, boardId).role).toBe('editor')
    })
  })

  describe('through the operations', () => {
    it('lets a write token write and a read token not', async () => {
      const writer = actorForToken('editor', { scopes: ['write'], agentLabel: 'n8n prod' }).actor!
      const reader = actorForToken('editor', { scopes: ['read'] }).actor!

      expect(await statusOf(ops.run(ops.ticketList, reader, { boardId }))).toBe(200)
      expect(await statusOf(ops.run(ops.ticketCreate, reader, { boardId, laneId, title: 'Nope' }))).toBe(403)

      const { ticket } = await ops.run(ops.ticketCreate, writer, { boardId, laneId, title: 'By a token' }) as { ticket: { id: string } }
      // The history names the person and the agent, and the audit entry names the credential.
      const created = db.listActivity(ticket.id)[0]!
      expect(created).toMatchObject({ agentId: 'n8n prod', channel: 'api' })
      expect(created.actor?.id).toBe(people.editor)
    })

    it('refuses to mint a token with a token', async () => {
      const writer = actorForToken('owner', { scopes: ['admin'] }).actor!
      expect(await statusOf(ops.run(ops.tokenCreate, writer, { name: 'escalation', scopes: ['admin'] }))).toBe(403)
    })

    it('keeps somebody else’s tokens out of reach unless you administer the instance', async () => {
      expect(await statusOf(ops.run(ops.tokenList, actorOf('editor'), { principalId: people.viewer }))).toBe(403)
      expect(await statusOf(ops.run(ops.tokenList, actorOf('owner'), { principalId: people.viewer }))).toBe(200)
      expect(await statusOf(ops.run(ops.tokenList, actorOf('editor'), {}))).toBe(200)
    })

    it('hands the secret back exactly once and never logs it', async () => {
      const audit = await import('../server/utils/audit')
      const result = await ops.run(ops.tokenCreate, actorOf('editor'), {
        name: 'personal', scopes: ['read', 'write'], agentLabel: 'Claude Desktop'
      }) as { token: { id: string }; secret: string }

      expect(result.secret.startsWith('bgs_')).toBe(true)
      // Listing them again returns records, never the secret.
      const { tokens } = await ops.run(ops.tokenList, actorOf('editor'), {}) as { tokens: Array<Record<string, unknown>> }
      expect(JSON.stringify(tokens)).not.toContain(result.secret)

      const entry = audit.listAudit({ operation: 'token.create' })[0]!
      expect(entry.changes).toMatchObject({ name: 'personal', scopes: ['read', 'write'], agentLabel: 'Claude Desktop' })
      expect(JSON.stringify(entry)).not.toContain(result.secret)
    })

    it('revokes a token and stops it working', async () => {
      const { minted } = actorForToken('editor', { name: 'doomed', scopes: ['write'] })
      expect(token.resolveToken(minted.token, 'api')).not.toBeNull()
      await ops.run(ops.tokenRevoke, actorOf('editor'), { tokenId: minted.id })
      expect(token.resolveToken(minted.token, 'api')).toBeNull()
    })

    it('lets an administrator mint a token for a service identity', async () => {
      const { service } = await ops.run(ops.serviceCreate, actorOf('owner'), { name: 'CI Bot' }) as { service: { id: string } }
      const result = await ops.run(ops.tokenCreate, actorOf('owner'), {
        name: 'ci', principalId: service.id, scopes: ['write'], boardId
      }) as { secret: string }

      db.setBoardMember(boardId, service.id, 'editor')
      const botActor = token.resolveToken(result.secret, 'api')!
      expect(botActor.principalId).toBe(service.id)

      const { ticket } = await ops.run(ops.ticketCreate, botActor, { boardId, laneId, title: 'Filed by CI' }) as { ticket: { id: string } }
      // The bot answers for its own work rather than borrowing a person's name.
      expect(db.listActivity(ticket.id)[0]!.actor?.id).toBe(service.id)

      // Disabling the principal is what stops every one of its tokens at once.
      await ops.run(ops.serviceSetStatus, actorOf('owner'), { serviceId: service.id, status: 'disabled' })
      expect(token.resolveToken(result.secret, 'api')).toBeNull()
    })
  })
})
