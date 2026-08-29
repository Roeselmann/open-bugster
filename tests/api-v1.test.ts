import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

describe('the v1 surface', () => {
  let routes: typeof import('../server/api/v1/routes')
  let openapi: typeof import('../server/utils/openapi')
  let problem: typeof import('../server/utils/problem')
  let rateLimit: typeof import('../server/utils/rate-limit')
  let db: typeof import('../server/utils/db')
  let ops: typeof import('../server/operations')

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-bugster-v1-'))
    process.env.DATABASE_PATH = join(directory, 'open-bugster.sqlite')
    process.env.ATTACHMENTS_PATH = join(directory, 'attachments')
    process.env.BUGSTER_SECRET_KEY = randomBytes(32).toString('base64')
    process.env.APP_PASSWORD_HASH = 'scrypt$abc$def'
    process.env.APP_ADMIN_EMAIL = 'owner@example.com'
    process.env.APP_ADMIN_FIRST_NAME = 'Grace'
    process.env.APP_ADMIN_LAST_NAME = 'Hopper'

    db = await import('../server/utils/db')
    ops = await import('../server/operations')
    routes = await import('../server/api/v1/routes')
    openapi = await import('../server/utils/openapi')
    problem = await import('../server/utils/problem')
    rateLimit = await import('../server/utils/rate-limit')
  })

  describe('the route table', () => {
    it('points every route at a registered operation', () => {
      for (const route of routes.v1Routes) {
        expect(ops.findOperation(route.operation.name), route.path).not.toBeNull()
      }
    })

    /**
     * The failure this prevents is quiet and nasty: a path saying `{boardId}` against an
     * operation whose input calls it something else resolves access on `undefined`.
     */
    it('names path parameters the operation’s schema actually has', () => {
      for (const route of routes.v1Routes) {
        const shape = z.toJSONSchema(route.operation.input, { io: 'input', unrepresentable: 'any' }) as {
          properties?: Record<string, unknown>
          anyOf?: Array<{ properties?: Record<string, unknown> }>
          oneOf?: Array<{ properties?: Record<string, unknown> }>
        }
        // A discriminated union keeps its fields in the branches — zod emits `oneOf` for one.
        const union = shape.oneOf ?? shape.anyOf
        const known = union
          ? [...new Set(union.flatMap(branch => Object.keys(branch.properties ?? {})))]
          : Object.keys(shape.properties ?? {})
        for (const param of [...route.path.matchAll(/\{(\w+)\}/g)].map(m => m[1]!)) {
          expect(known, `${route.method} ${route.path}`).toContain(param)
        }
      }
    })

    it('gives every path and method pair exactly one route', () => {
      const seen = new Set<string>()
      for (const route of routes.v1Routes) {
        const key = `${route.method} ${route.path}`
        expect(seen.has(key), key).toBe(false)
        seen.add(key)
      }
    })

    it('keeps instance administration off the public surface', () => {
      // Tokens, accounts, service identities and the App Store Connect key are deliberately
      // not reachable with a token. If one is added, it should be on purpose.
      const exposed = routes.v1Routes.map(route => route.operation.name)
      for (const name of ['user.create', 'user.delete', 'token.create', 'service.create', 'board.setKey', 'profile.changePassword']) {
        expect(exposed).not.toContain(name)
      }
    })

    it('matches paths, fills parameters, and tells a wrong verb from a wrong URL', () => {
      const matched = routes.matchRoute('GET', '/boards/b_1/tickets')
      expect(matched?.route.operation.name).toBe('ticket.list')
      expect(matched?.params).toEqual({ boardId: 'b_1' })

      expect(routes.matchRoute('GET', '/nothing/here')).toBeNull()
      // The URL is right and the verb is not, which is worth saying rather than a flat 404.
      expect(() => routes.matchRoute('DELETE', '/tickets')).toThrow()
      try {
        routes.matchRoute('DELETE', '/tickets')
      } catch (error) {
        expect((error as { statusCode?: number }).statusCode).toBe(405)
      }
    })

    it('keeps a literal segment from being eaten by the id route beside it', () => {
      // `/tickets/{ticketId}` is declared first and matches one segment, so it cannot swallow
      // this — but the two live next to each other, and the order is worth pinning down.
      const matched = routes.matchRoute('GET', '/tickets/by-number/42')
      expect(matched?.route.operation.name).toBe('ticket.getByNumber')
      expect(matched?.params).toEqual({ ticketNumber: '42' })
    })

    it('decodes a parameter that arrived percent-encoded', () => {
      expect(routes.matchRoute('GET', '/tickets/a%2Fb')?.params.ticketId).toBe('a/b')
    })
  })

  describe('the OpenAPI document', () => {
    let spec: ReturnType<typeof openapi.buildOpenApiDocument>

    beforeAll(() => { spec = openapi.buildOpenApiDocument('https://bugs.example.com') })

    it('is 3.1, which is what makes zod’s output usable unchanged', () => {
      expect(spec.openapi).toBe('3.1.0')
      expect(spec.servers[0]!.url).toBe('https://bugs.example.com/api/v1')
    })

    it('describes every route in the table and nothing else', () => {
      const described = Object.entries(spec.paths).flatMap(([path, methods]) =>
        Object.keys(methods).map(method => `${method.toUpperCase()} ${path}`))
      const declared = routes.v1Routes.map(route => `${route.method} ${route.path}`)
      expect(described.sort()).toEqual(declared.sort())
    })

    it('resolves every reference it makes', () => {
      const text = JSON.stringify(spec)
      const names = new Set(Object.keys(spec.components.schemas))
      const referenced = [...text.matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)].map(match => match[1]!)
      expect([...new Set(referenced)].filter(name => !names.has(name))).toEqual([])
      // `$defs` is zod's word for it; nothing should still be pointing there.
      expect(text).not.toContain('#/$defs/')
    })

    it('publishes named types rather than __schema0', () => {
      expect(JSON.stringify(spec)).not.toContain('__schema')
      expect(Object.keys(spec.components.schemas)).toEqual(
        expect.arrayContaining(['Ticket', 'Person', 'BoardSummary', 'TicketComment', 'Problem'])
      )
    })

    it('marks every endpoint as needing a token, and documents the failures', () => {
      expect(spec.security).toEqual([{ bearerAuth: [] }])
      for (const methods of Object.values(spec.paths)) {
        for (const operation of Object.values(methods) as Array<{ responses: Record<string, unknown> }>) {
          for (const status of ['401', '403', '404', '422', '429']) {
            expect(Object.keys(operation.responses)).toContain(status)
          }
        }
      }
    })

    it('offers Idempotency-Key on writes and not on reads', () => {
      const post = spec.paths['/tickets']!.post as { parameters: Array<{ name: string }> }
      expect(post.parameters.map(p => p.name)).toContain('Idempotency-Key')
      const get = spec.paths['/tickets/{ticketId}']!.get as { parameters: Array<{ name: string }> }
      expect(get.parameters.map(p => p.name)).not.toContain('Idempotency-Key')
    })

    it('documents a ticket number as the integer path parameter it is', () => {
      const get = spec.paths['/tickets/by-number/{ticketNumber}']!.get as {
        parameters: Array<{ name: string; in: string; required: boolean; schema: { type?: string } }>
      }
      const parameter = get.parameters.find(p => p.name === 'ticketNumber')!
      expect(parameter).toMatchObject({ in: 'path', required: true })
      // Coerced from text in the schema, so the published type is the one a caller sends.
      expect(parameter.schema.type).toBe('integer')
      // The id route keeps its own shape: a second way in is not a second parameter on the first.
      const byId = spec.paths['/tickets/{ticketId}']!.get as { parameters: Array<{ name: string }> }
      expect(byId.parameters.map(p => p.name)).not.toContain('ticketNumber')
    })

    /**
     * `lane.delete` takes a discriminated union, and the internal API sends it as a DELETE
     * body. A body on a DELETE is legal but widely mishandled — plenty of HTTP clients and
     * proxies drop it — so the public surface takes the same fields as query parameters
     * instead, and the generator has to find them inside the union's branches.
     */
    it('lifts a union input’s fields onto a DELETE’s query string', () => {
      const del = spec.paths['/boards/{boardId}/lanes/{laneId}']!.delete as {
        parameters: Array<{ name: string; in: string; required: boolean }>
        requestBody?: unknown
      }
      expect(del.requestBody).toBeUndefined()
      const query = del.parameters.filter(p => p.in === 'query').map(p => p.name)
      expect(query).toEqual(expect.arrayContaining(['mode', 'targetLaneId']))

      // `mode` is demanded by both branches; `targetLaneId` only by one, so it is optional.
      const byName = Object.fromEntries(del.parameters.map(p => [p.name, p]))
      expect(byName.mode!.required).toBe(true)
      expect(byName.targetLaneId!.required).toBe(false)
      expect(del.parameters.filter(p => p.in === 'path').map(p => p.name)).toEqual(['boardId', 'laneId'])
    })

    it('puts a GET’s non-path inputs in the query string, not a body', () => {
      const get = spec.paths['/boards/{boardId}/tickets']!.get as { parameters: Array<{ name: string; in: string }>; requestBody?: unknown }
      expect(get.requestBody).toBeUndefined()
      const query = get.parameters.filter(p => p.in === 'query').map(p => p.name)
      expect(query).toEqual(expect.arrayContaining(['archived', 'limit', 'cursor']))
    })
  })

  describe('problem documents', () => {
    it('maps a status to a stable type', () => {
      const notFound = problem.toProblem({ statusCode: 404, statusMessage: 'Ticket not found.' })
      expect(notFound).toMatchObject({
        type: 'https://open-bugster.dev/problems/not-found',
        title: 'Not found',
        status: 404,
        detail: 'Ticket not found.'
      })
    })

    it('carries validation issues through', () => {
      const invalid = problem.toProblem({ statusCode: 422, statusMessage: 'Invalid input', data: { issues: { title: ['required'] } } })
      expect(invalid.errors).toEqual({ title: ['required'] })
    })

    it('says nothing about an internal failure', () => {
      // The message is written for whoever reads the logs, and is exactly the sort of string
      // that leaks a path or a query.
      const broken = problem.toProblem(new Error('SQLITE_ERROR: no such column: secret_column'))
      expect(broken.status).toBe(500)
      expect(broken.detail).toBeUndefined()
      expect(JSON.stringify(broken)).not.toContain('secret_column')
    })

    it('treats a nonsense status as a 500 rather than passing it on', () => {
      expect(problem.toProblem({ statusCode: 999 }).status).toBe(500)
      expect(problem.toProblem({ statusCode: 200 }).status).toBe(500)
    })
  })

  describe('rate limiting', () => {
    beforeEach(() => {
      rateLimit.resetRateLimits()
      process.env.API_RATE_LIMIT = '3'
    })

    it('allows up to the limit and then refuses', () => {
      const results = [1, 2, 3, 4].map(() => rateLimit.checkRateLimit('token_a'))
      expect(results.map(r => r.allowed)).toEqual([true, true, true, false])
      expect(results[0]!.remaining).toBe(2)
      expect(results[3]!.retryAfter).toBeGreaterThan(0)
    })

    it('counts each credential separately', () => {
      for (let i = 0; i < 3; i++) rateLimit.checkRateLimit('token_a')
      expect(rateLimit.checkRateLimit('token_a').allowed).toBe(false)
      expect(rateLimit.checkRateLimit('token_b').allowed).toBe(true)
    })

    it('starts a fresh window once the old one has passed', () => {
      const start = 1_000_000
      for (let i = 0; i < 4; i++) rateLimit.checkRateLimit('token_c', start)
      expect(rateLimit.checkRateLimit('token_c', start).allowed).toBe(false)
      expect(rateLimit.checkRateLimit('token_c', start + rateLimit.rateLimitWindowMs()).allowed).toBe(true)
    })
  })

  describe('paging a board', () => {
    let boardId = ''

    beforeAll(() => {
      const board = db.listBoards()[0]!
      boardId = board.id
      const laneId = board.lanes.find(lane => !lane.isImport)!.id
      for (let i = 1; i <= 7; i++) db.createTicket(boardId, { title: `Ticket ${i}`, laneId } as never, null)
    })

    it('walks the whole board in stable order and stops', () => {
      const seen: number[] = []
      let cursor: number | null = null
      for (let guard = 0; guard < 10; guard++) {
        const page: { tickets: Array<{ ticketNumber: number }>; nextCursor: number | null } =
          db.listTicketsPage(boardId, { limit: 3, cursor })
        seen.push(...page.tickets.map(ticket => ticket.ticketNumber))
        if (page.nextCursor === null) break
        cursor = page.nextCursor
      }
      expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7])
    })

    it('reports no next page on the last one, even when it is exactly full', () => {
      const page = db.listTicketsPage(boardId, { limit: 7, cursor: 0 })
      expect(page.tickets).toHaveLength(7)
      expect(page.nextCursor).toBeNull()
    })

    it('leaves the unpaged listing alone, which is what the board view uses', async () => {
      const all = await ops.run(ops.ticketList, actorFor(), { boardId }) as { tickets: unknown[]; nextCursor?: unknown }
      expect(all.tickets).toHaveLength(7)
      expect(all.nextCursor).toBeUndefined()
    })

    function actorFor() {
      const owner = db.findUser(db.listUsers()[0]!.id)!
      return { principalId: owner.id, agentId: null, tokenId: null, channel: 'api' as const, principal: owner, scopes: null, boardScope: null }
    }
  })
})
