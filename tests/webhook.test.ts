import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

describe('outgoing webhooks', () => {
  let db: typeof import('../server/utils/db')
  let hooks: typeof import('../server/utils/webhook')
  let actorModule: typeof import('../server/utils/actor')
  let ops: typeof import('../server/operations')

  let boardId = ''
  let laneId = ''
  let ownerId = ''

  /** A real receiver, so signing and retries are exercised over an actual socket. */
  let receiver: Server
  let receiverUrl = ''
  const received: Array<{ headers: Record<string, string>; body: string }> = []
  let replyWith = 200
  let failuresBeforeSuccess = 0

  const actorOf = () => actorModule.actorFor(db.findUser(ownerId)!, { channel: 'api', agentId: 'n8n prod', tokenId: 'tok_1' })
  const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms))

  /**
   * Waits for a condition rather than for a duration.
   *
   * Delivery is asynchronous and retried on a backoff, so a fixed sleep is a race: it passes
   * on an idle machine and fails when the suite runs the files in parallel. Polling is stable
   * under load and still finishes as soon as the work is actually done.
   */
  const waitFor = async (predicate: () => boolean | Promise<boolean>, deadlineMs = 5000) => {
    const until = Date.now() + deadlineMs
    while (Date.now() < until) {
      if (await predicate()) return true
      await settle(20)
    }
    return false
  }
  const statusOf = async (promise: Promise<unknown>) => {
    try {
      await promise
      return 200
    } catch (error) {
      return (error as { statusCode?: number }).statusCode ?? 500
    }
  }

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-webhook-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.ATTACHMENTS_PATH = join(directory, 'attachments')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    process.env.APP_PASSWORD_HASH = 'scrypt$abc$def'
    process.env.APP_ADMIN_EMAIL = 'owner@example.com'
    process.env.APP_ADMIN_FIRST_NAME = 'Grace'
    process.env.APP_ADMIN_LAST_NAME = 'Hopper'
    // The receiver below is on localhost, which is exactly the case this setting is for.
    process.env.WEBHOOK_ALLOW_PRIVATE = 'true'

    db = await import('../server/utils/db')
    hooks = await import('../server/utils/webhook')
    actorModule = await import('../server/utils/actor')
    ops = await import('../server/operations')

    const board = db.listBoards()[0]!
    boardId = board.id
    laneId = board.lanes.find(lane => !lane.isImport)!.id
    ownerId = db.listUsers()[0]!.id

    receiver = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        received.push({ headers: request.headers as Record<string, string>, body })
        const status = failuresBeforeSuccess > 0 ? 500 : replyWith
        if (failuresBeforeSuccess > 0) failuresBeforeSuccess -= 1
        response.writeHead(status)
        response.end('ok')
      })
    })
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`
  })

  afterAll(async () => {
    await new Promise<void>(resolve => receiver.close(() => resolve()))
  })

  describe('screening a destination', () => {
    it('refuses link-local, which is where the cloud metadata service lives', async () => {
      // 169.254.169.254 hands out credentials to anything that asks. No webhook needs it.
      await expect(hooks.assertDeliverable('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(hooks.WebhookUrlError)
    })

    it('refuses anything that is not http or https, and URLs carrying credentials', async () => {
      await expect(hooks.assertDeliverable('file:///etc/passwd')).rejects.toThrow(hooks.WebhookUrlError)
      await expect(hooks.assertDeliverable('gopher://example.com/')).rejects.toThrow(hooks.WebhookUrlError)
      await expect(hooks.assertDeliverable('https://user:pass@example.com/')).rejects.toThrow(hooks.WebhookUrlError)
      await expect(hooks.assertDeliverable('not a url at all')).rejects.toThrow(hooks.WebhookUrlError)
    })

    it('allows a private address by default, which is where n8n usually is', async () => {
      await expect(hooks.assertDeliverable('http://127.0.0.1:9000/hook')).resolves.toBeInstanceOf(URL)
      await expect(hooks.assertDeliverable('http://10.1.2.3/hook')).resolves.toBeInstanceOf(URL)
    })

    it('refuses one when the instance is set to public targets only', async () => {
      process.env.WEBHOOK_ALLOW_PRIVATE = 'false'
      await expect(hooks.assertDeliverable('http://192.168.1.10/hook')).rejects.toThrow(hooks.WebhookUrlError)
      // Link-local stays refused either way.
      await expect(hooks.assertDeliverable('http://169.254.169.254/')).rejects.toThrow(hooks.WebhookUrlError)
      process.env.WEBHOOK_ALLOW_PRIVATE = 'true'
    })
  })

  describe('signing', () => {
    it('round-trips a signature it produced', () => {
      const body = JSON.stringify({ event: 'ticket.created' })
      expect(hooks.verifySignature('whsec_x', body, hooks.signPayload('whsec_x', body))).toBe(true)
    })

    it('rejects a wrong secret, a changed body, and a stale timestamp', () => {
      const body = JSON.stringify({ event: 'ticket.created' })
      const signature = hooks.signPayload('whsec_x', body)
      expect(hooks.verifySignature('whsec_other', body, signature)).toBe(false)
      expect(hooks.verifySignature('whsec_x', `${body} `, signature)).toBe(false)
      // The timestamp is inside the signed material, so an old capture cannot be replayed.
      const old = hooks.signPayload('whsec_x', body, Math.floor(Date.now() / 1000) - 3600)
      expect(hooks.verifySignature('whsec_x', body, old)).toBe(false)
    })

    it('rejects a malformed header rather than throwing', () => {
      expect(hooks.verifySignature('whsec_x', 'body', 'nonsense')).toBe(false)
      expect(hooks.verifySignature('whsec_x', 'body', 't=abc,v1=zz')).toBe(false)
    })
  })

  describe('delivering', () => {
    let webhookId = ''
    let secret = ''

    beforeAll(async () => {
      const result = await ops.run(ops.webhookCreate, actorOf(), {
        boardId, url: receiverUrl, events: ['ticket.created', 'comment.added'], description: 'test receiver'
      }) as { webhook: { id: string }; secret: string }
      webhookId = result.webhook.id
      secret = result.secret
    })

    it('hands the secret back once and never again', async () => {
      expect(secret.startsWith('whsec_')).toBe(true)
      const { webhooks } = await ops.run(ops.webhookList, actorOf(), { boardId }) as { webhooks: Array<Record<string, unknown>> }
      expect(JSON.stringify(webhooks)).not.toContain(secret)
      expect(webhooks[0]).not.toHaveProperty('secret')
    })

    it('fires on a subscribed event, signed and with the actor attached', async () => {
      received.length = 0
      await ops.run(ops.ticketCreate, actorOf(), { boardId, laneId, title: 'Fires a webhook' })
      expect(await waitFor(() => received.length === 1)).toBe(true)

      const delivery = received[0]!
      expect(delivery.headers['x-bugster-event']).toBe('ticket.created')
      expect(delivery.headers['x-bugster-delivery']).toBeTruthy()
      expect(hooks.verifySignature(secret, delivery.body, delivery.headers['x-bugster-signature']!)).toBe(true)

      const payload = JSON.parse(delivery.body)
      expect(payload).toMatchObject({
        event: 'ticket.created',
        boardId,
        actor: { principalId: ownerId, agentId: 'n8n prod', channel: 'api' }
      })
      expect(payload.data.ticket.title).toBe('Fires a webhook')
    })

    it('stays quiet for an event nobody subscribed to', async () => {
      received.length = 0
      const { ticket } = await ops.run(ops.ticketCreate, actorOf(), { boardId, laneId, title: 'Moved later' }) as { ticket: { id: string } }
      await settle()
      received.length = 0
      // `ticket.moved` is not on this webhook's list.
      await ops.run(ops.ticketMove, actorOf(), { ticketId: ticket.id, laneId, index: 0 })
      await settle()
      expect(received).toHaveLength(0)
    })

    it('says nothing about a refused operation', async () => {
      received.length = 0
      // A viewer cannot create, and a workflow should not hear about the attempt.
      const viewer = db.createUser({ email: 'viewer@example.com', firstName: 'V', lastName: 'R', role: 'member' })
      db.setBoardMember(boardId, viewer.id, 'viewer')
      await statusOf(ops.run(ops.ticketCreate, actorModule.actorFor(db.findUser(viewer.id)!), { boardId, laneId, title: 'Refused' }))
      await settle()
      expect(received).toHaveLength(0)
    })

    it('records what happened on each attempt', async () => {
      const { deliveries } = await ops.run(ops.webhookDeliveries, actorOf(), { webhookId }) as { deliveries: Array<{ status: number | null; event: string }> }
      expect(deliveries.length).toBeGreaterThan(0)
      expect(deliveries[0]!.status).toBe(200)
    })

    it('retries a failing receiver and succeeds when it recovers', async () => {
      received.length = 0
      failuresBeforeSuccess = 2
      // The real backoff is 1s then 4s; turned down here so the test costs 250ms, not nine
      // seconds. The shape being checked — squared, and it gives up eventually — is the same.
      process.env.WEBHOOK_RETRY_BASE_MS = '20'
      await ops.run(ops.ticketCreate, actorOf(), { boardId, laneId, title: 'Retried' })
      const arrived = await waitFor(() => received.length >= 3)
      delete process.env.WEBHOOK_RETRY_BASE_MS

      expect(arrived).toBe(true)
      const { deliveries } = await ops.run(ops.webhookDeliveries, actorOf(), { webhookId }) as { deliveries: Array<{ status: number | null; attempt: number }> }
      const attempts = deliveries.slice(0, 3).map(delivery => delivery.attempt).sort()
      expect(attempts).toEqual([1, 2, 3])
      expect(deliveries[0]!.status).toBe(200)
      failuresBeforeSuccess = 0
    })

    it('gives up after five attempts and records every one', async () => {
      received.length = 0
      const doomed = await ops.run(ops.webhookCreate, actorOf(), {
        boardId, url: receiverUrl, events: ['comment.added']
      }) as { webhook: { id: string } }
      // The healthy receiver is parked, so only the doomed hook's attempts are in play.
      await ops.run(ops.webhookUpdate, actorOf(), { webhookId, enabled: false })
      // Never recovers, so every attempt fails.
      failuresBeforeSuccess = 99
      process.env.WEBHOOK_RETRY_BASE_MS = '10'

      const { ticket } = await ops.run(ops.ticketCreate, actorOf(), { boardId, laneId, title: 'Never lands' }) as { ticket: { id: string } }
      await ops.run(ops.commentAdd, actorOf(), { ticketId: ticket.id, body: 'triggers the doomed hook' })

      const attemptsOf = async () => {
        const { deliveries } = await ops.run(ops.webhookDeliveries, actorOf(), { webhookId: doomed.webhook.id }) as {
          deliveries: Array<{ attempt: number; status: number | null }>
        }
        return deliveries
      }
      await waitFor(async () => (await attemptsOf()).length >= 5)
      // A moment past the last attempt, to catch a sixth if the cap were not holding.
      await settle(200)

      delete process.env.WEBHOOK_RETRY_BASE_MS
      failuresBeforeSuccess = 0
      await ops.run(ops.webhookUpdate, actorOf(), { webhookId, enabled: true })

      const deliveries = await attemptsOf()
      // Five attempts, and then it stops rather than retrying for ever.
      expect(deliveries.map(delivery => delivery.attempt).sort()).toEqual([1, 2, 3, 4, 5])
      expect(deliveries.every(delivery => delivery.status === 500)).toBe(true)
      await ops.run(ops.webhookDelete, actorOf(), { webhookId: doomed.webhook.id })
    })

    it('does not let a dead receiver slow the operation down', async () => {
      received.length = 0
      await ops.run(ops.webhookUpdate, actorOf(), { webhookId, url: 'http://127.0.0.1:1/nothing-listens-here' })
      const started = Date.now()
      await ops.run(ops.ticketCreate, actorOf(), { boardId, laneId, title: 'Fast anyway' })
      // Fire and forget: the operation returns without waiting on the socket.
      expect(Date.now() - started).toBeLessThan(500)
      await ops.run(ops.webhookUpdate, actorOf(), { webhookId, url: receiverUrl })
    })
  })

  describe('administration', () => {
    it('is a board admin’s, not any editor’s', async () => {
      const editor = db.createUser({ email: 'editor@example.com', firstName: 'E', lastName: 'D', role: 'member' })
      db.setBoardMember(boardId, editor.id, 'editor')
      const asEditor = actorModule.actorFor(db.findUser(editor.id)!)
      expect(await statusOf(ops.run(ops.webhookList, asEditor, { boardId }))).toBe(403)
      expect(await statusOf(ops.run(ops.webhookCreate, asEditor, { boardId, url: receiverUrl, events: ['ticket.created'] }))).toBe(403)
    })

    it('refuses a destination that would not be delivered to', async () => {
      expect(await statusOf(ops.run(ops.webhookCreate, actorOf(), {
        boardId, url: 'http://169.254.169.254/latest/meta-data/', events: ['ticket.created']
      }))).toBe(422)
    })

    it('audits the URL and the events but never the secret', async () => {
      const audit = await import('../server/utils/audit')
      const created = await ops.run(ops.webhookCreate, actorOf(), {
        boardId, url: `${receiverUrl}/audited`, events: ['ticket.created']
      }) as { webhook: { id: string }; secret: string }

      const entry = audit.listAudit({ operation: 'webhook.create' })[0]!
      expect(entry.targetId).toBe(created.webhook.id)
      expect(entry.changes).toMatchObject({ events: ['ticket.created'] })
      expect(JSON.stringify(entry)).not.toContain(created.secret)
      await ops.run(ops.webhookDelete, actorOf(), { webhookId: created.webhook.id })
    })

    /**
     * What the settings page's edit button does. The point of editing in place rather than
     * recreating: the secret the receiver already holds, and the delivery log, both survive.
     */
    it('changes which events a webhook subscribes to, keeping its secret and its log', async () => {
      received.length = 0
      const created = await ops.run(ops.webhookCreate, actorOf(), {
        boardId, url: receiverUrl, events: ['ticket.created'], description: 'before'
      }) as { webhook: { id: string }; secret: string }

      // Other webhooks on this board point at the same receiver, so a delivery is recognised
      // by the secret that signed it rather than by counting what arrived.
      const mine = () => received.filter(delivery =>
        hooks.verifySignature(created.secret, delivery.body, delivery.headers['x-bugster-signature']!))

      await ops.run(ops.ticketCreate, actorOf(), { boardId, laneId, title: 'Before the edit' })
      expect(await waitFor(() => mine().length === 1)).toBe(true)

      const { webhook } = await ops.run(ops.webhookUpdate, actorOf(), {
        webhookId: created.webhook.id, events: ['comment.added'], description: 'after'
      }) as { webhook: { events: string[]; description: string; enabled: boolean } }
      expect(webhook).toMatchObject({ events: ['comment.added'], description: 'after', enabled: true })

      // The old event stops arriving, the new one starts, and the secret still verifies.
      received.length = 0
      const { ticket } = await ops.run(ops.ticketCreate, actorOf(), { boardId, laneId, title: 'After the edit' }) as { ticket: { id: string } }
      await settle()
      expect(mine()).toHaveLength(0)

      received.length = 0
      await ops.run(ops.commentAdd, actorOf(), { ticketId: ticket.id, body: 'Now this one fires.' })
      expect(await waitFor(() => mine().length === 1)).toBe(true)
      expect(mine()[0]!.headers['x-bugster-event']).toBe('comment.added')

      // The log kept what the webhook did before the edit.
      const { deliveries } = await ops.run(ops.webhookDeliveries, actorOf(), { webhookId: created.webhook.id }) as {
        deliveries: Array<{ event: string }>
      }
      expect(deliveries.map(entry => entry.event)).toContain('ticket.created')
      await ops.run(ops.webhookDelete, actorOf(), { webhookId: created.webhook.id })
    })

    it('re-enabling clears the failure count', async () => {
      const created = await ops.run(ops.webhookCreate, actorOf(), {
        boardId, url: receiverUrl, events: ['ticket.created']
      }) as { webhook: { id: string } }
      db.getDb().prepare('UPDATE webhooks SET consecutive_failures = 9, enabled = 0, disabled_at = ? WHERE id = ?')
        .run(new Date().toISOString(), created.webhook.id)

      const { webhook } = await ops.run(ops.webhookUpdate, actorOf(), { webhookId: created.webhook.id, enabled: true }) as {
        webhook: { enabled: boolean; consecutiveFailures: number; disabledAt: string | null }
      }
      expect(webhook).toMatchObject({ enabled: true, consecutiveFailures: 0, disabledAt: null })
      await ops.run(ops.webhookDelete, actorOf(), { webhookId: created.webhook.id })
    })
  })

  /**
   * The settings page documents each event from the shared catalogue. If an event is added to
   * the sender without a line here, the page would quietly stop describing what it sends.
   */
  describe('the documented catalogue', () => {
    it('describes exactly the events the sender can raise, in the same order', async () => {
      const { WEBHOOK_EVENTS } = await import('../shared/utils/webhook-catalogue')
      expect(WEBHOOK_EVENTS.map(entry => entry.event)).toEqual([...hooks.webhookEvents])
    })

    it('names the operation each event really comes from', async () => {
      const { WEBHOOK_EVENTS } = await import('../shared/utils/webhook-catalogue')
      for (const entry of WEBHOOK_EVENTS) {
        expect(hooks.eventForOperation[entry.operation]).toBe(entry.event)
      }
      expect(WEBHOOK_EVENTS.length).toBe(Object.keys(hooks.eventForOperation).length)
    })
  })
})
