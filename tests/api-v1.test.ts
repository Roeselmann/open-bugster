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

    it('reaches every structure operation the MCP tools use', () => {
      // Parity with the structure tools: whatever an agent can do to a board, a script can.
      const exposed = new Map(routes.v1Routes.map(route => [route.operation.name, `${route.method} ${route.path}`]))
      expect(Object.fromEntries(['board.create', 'board.update', 'board.delete', 'board.structure.list',
        'lane.create', 'lane.update', 'lane.reorder', 'lane.delete',
        'member.candidates', 'member.set', 'member.remove',
        'category.list', 'category.create', 'category.update', 'category.delete',
        'label.list', 'label.rename', 'label.delete',
        'ticket.type.list', 'ticket.type.create', 'ticket.type.update', 'ticket.type.delete', 'ticket.type.reorder', 'ticket.move'
      ].map(name => [name, exposed.has(name)]))).toEqual(expect.not.objectContaining({ '': false }))
      for (const name of ['board.structure.list', 'category.create', 'label.rename', 'label.delete', 'ticket.type.create', 'ticket.type.update', 'ticket.type.delete', 'ticket.type.reorder', 'category.update', 'category.delete', 'label.list']) {
        expect(exposed.has(name), name).toBe(true)
      }
      // The full audit log and the workspace itself stay off it.
      expect(exposed.has('audit.list')).toBe(false)
      expect(exposed.has('workspace.create')).toBe(false)
      expect(exposed.get('label.rename')).toBe('PATCH /boards/{boardId}/labels/{name}')
      expect(exposed.get('label.delete')).toBe('DELETE /boards/{boardId}/labels/{name}')
      expect(exposed.get('category.create')).toBe('POST /boards/{boardId}/categories')
      expect(exposed.get('board.structure.list')).toBe('GET /boards/{boardId}/structure-log')
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
        expect.arrayContaining(['Ticket', 'Person', 'BoardSummary', 'TicketComment', 'Problem', 'TicketTypeSummary', 'TicketTypeIcon', 'TicketTypeRef', 'TimelineNode'])
      )
      // Recursive, so its subtickets point back at itself rather than at an unnamed piece.
      const node = spec.components.schemas.TimelineNode as { properties: { children: { items: { $ref: string } } } }
      expect(node.properties.children.items.$ref).toBe('#/components/schemas/TimelineNode')
    })

    it('publishes the ticket types of a workspace', () => {
      expect(spec.paths['/workspaces/{workspaceId}/ticket-types']).toHaveProperty('get')
      expect(spec.paths['/workspaces/{workspaceId}/ticket-types'].get.operationId).toBe('ticketTypeList')
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

    it('publishes an upload as base64 text, so a generator knows how to send a file', () => {
      const post = spec.paths['/tickets/{ticketId}/attachments']!.post as {
        requestBody: { content: Record<string, { schema: { properties: Record<string, { contentEncoding?: string }> } }> }
      }
      const body = post.requestBody.content['application/json']!.schema
      expect(body.properties.content).toMatchObject({ contentEncoding: 'base64' })
      // The path parameter is not also asked for in the body.
      expect(Object.keys(body.properties)).not.toContain('ticketId')
    })

    it('publishes a download as bytes rather than as JSON', () => {
      const get = spec.paths['/attachments/{attachmentId}']!.get as {
        responses: Record<string, { content: Record<string, { schema: { type?: string; format?: string } }> }>
      }
      const ok = get.responses['200']!.content
      expect(Object.keys(ok)).toEqual(['application/octet-stream'])
      expect(ok['application/octet-stream']!.schema).toMatchObject({ type: 'string', format: 'binary' })
      // The failures stay JSON — a generator has to know a 404 is still a Problem document.
      expect(Object.keys(get.responses['404']!.content)).toEqual(['application/problem+json'])
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

    it('offers every branch of a union\'s discriminator, not just the first', () => {
      const del = spec.paths['/boards/{boardId}/lanes/{laneId}']!.delete as { parameters: Array<{ name: string; schema: { enum?: string[] } }> }
      expect(del.parameters.find(p => p.name === 'mode')!.schema.enum).toEqual(['move', 'archive', 'empty'])
    })

    /**
     * zod numbers the unnamed pieces of every schema it converts from `__schema0` again, so
     * folding them into one registry afterwards handed every route the last conversion's.
     */
    it('keeps every route\'s own unnamed schemas, rather than whichever was converted last', () => {
      for (const [path, methods] of Object.entries(spec.paths)) {
        for (const [method, operation] of Object.entries(methods) as Array<[string, { parameters: Array<{ name: string; in: string; schema: { type?: unknown } }> }]>) {
          for (const parameter of operation.parameters.filter(p => p.in === 'path')) {
            expect(['string', 'integer'], `${method} ${path} ${parameter.name}`).toContain(parameter.schema.type)
          }
        }
      }
      const del = spec.paths['/boards/{boardId}']!.delete as { parameters: Array<{ name: string; in: string; required: boolean; schema: { type?: string } }> }
      expect(del.parameters.find(p => p.name === 'onlyIfEmpty')).toMatchObject({ in: 'query', required: false, schema: { type: 'boolean' } })
    })

    it('publishes the extended inputs of board and lane creation', () => {
      const board = (spec.paths['/boards']!.post as { requestBody: { content: Record<string, { schema: { properties: Record<string, { type?: string; items?: { properties?: Record<string, unknown> } }>; required: string[] } }> } })
        .requestBody.content['application/json']!.schema
      expect(board.properties.description).toMatchObject({ type: 'string' })
      expect(board.properties.lanes).toMatchObject({ type: 'array' })
      expect(Object.keys(board.properties.lanes!.items!.properties!)).toEqual(['name', 'isDone', 'isLive'])
      expect(board.required).toEqual(['name'])
      const lane = (spec.paths['/boards/{boardId}/lanes']!.post as { requestBody: { content: Record<string, { schema: { properties: Record<string, { type?: string }>; required: string[] } }> } })
        .requestBody.content['application/json']!.schema
      expect(lane.properties.isDone).toMatchObject({ type: 'boolean' })
      expect(lane.required).toEqual(['name'])
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

  /**
   * The routes as the dispatcher runs them: defaults, then the query string (already coerced to
   * booleans and numbers), then the body, then the path last — all through `run` as a token.
   */
  describe('structure over v1', () => {
    const owner = () => db.findUser(db.listUsers()[0]!.id)!
    const token = (scopes: Array<'read' | 'write' | 'admin'> = ['read', 'write', 'admin']) =>
      ({ principalId: owner().id, agentId: 'script', tokenId: 'tok_v1', channel: 'api' as const, principal: owner(), scopes, boardScope: null })
    const send = async <T = Record<string, any>>(method: string, path: string, { query = {}, body = {}, scopes }: { query?: Record<string, unknown>; body?: Record<string, unknown>; scopes?: Array<'read' | 'write' | 'admin'> } = {}) => {
      const matched = routes.matchRoute(method, path)
      if (!matched) throw new Error(`no route for ${method} ${path}`)
      const input = { ...matched.route.defaults, ...query, ...(method === 'GET' || method === 'DELETE' ? {} : body), ...matched.params }
      return { status: matched.route.status ?? 200, body: await ops.run(matched.route.operation, token(scopes), input) as T }
    }

    it('opens a board with its own lanes, adds a flagged lane, and keeps the old defaults', async () => {
      const created = await send('POST', '/boards', { body: { name: 'Scripted', description: 'By a script', lanes: [{ name: 'In' }, { name: 'Out', isDone: true }] } })
      expect(created.status).toBe(201)
      expect(created.body.board.lanes.map((lane: { name: string; isDone: boolean }) => [lane.name, lane.isDone])).toEqual([['In', false], ['Out', true]])
      expect(created.body.board.description).toBe('By a script')
      const lane = await send('POST', `/boards/${created.body.board.id}/lanes`, { body: { name: 'Live', isLive: true } })
      expect(lane.status).toBe(201)
      expect(lane.body.lane).toMatchObject({ name: 'Live', isLive: true, isDone: false })
      // A name alone is what a client that predates this sent, and it still gets the four.
      const plain = await send('POST', '/boards', { body: { name: 'Plain' } })
      expect(plain.body.board.lanes.map((item: { name: string }) => item.name)).toEqual(['Import', 'Backlog', 'In Progress', 'Done'])
      expect((await send('POST', `/boards/${plain.body.board.id}/lanes`, { body: { name: 'Extra' } })).body.lane).toMatchObject({ isDone: false, isLive: false })
    })

    it('deletes a board with tickets only without onlyIfEmpty', async () => {
      const board = (await send('POST', '/boards', { body: { name: 'Doomed', lanes: [{ name: 'Only' }] } })).body.board
      db.createTicket(board.id, { title: 'Holds it', laneId: board.lanes[0].id } as never, null)
      await expect(send('DELETE', `/boards/${board.id}`, { query: { onlyIfEmpty: true } })).rejects.toMatchObject({ statusCode: 409 })
      expect(db.findBoard(board.id)).not.toBeNull()
      expect((await send('DELETE', `/boards/${board.id}`)).status).toBe(204)
      expect(db.findBoard(board.id)).toBeNull()
    })

    it('creates categories and renames, merges and deletes labels by name', async () => {
      const board = (await send('POST', '/boards', { body: { name: 'Vocabulary', lanes: [{ name: 'Only' }] } })).body.board
      const category = await send('POST', `/boards/${board.id}/categories`, { body: { name: 'Ops', color: 'teal' } })
      expect(category).toMatchObject({ status: 201, body: { category: { name: 'Ops', color: 'teal' } } })
      db.createTicket(board.id, { title: 'Labelled', laneId: board.lanes[0].id, labels: ['needs review', 'qa'] } as never, null)
      const renamed = await send('PATCH', `/boards/${board.id}/labels/${encodeURIComponent('Needs Review')}`, { body: { newName: 'QA' } })
      expect(renamed.body).toMatchObject({ ticketsTouched: 1, merged: true, label: { name: 'qa' } })
      expect(renamed.body.labels.map((label: { name: string }) => label.name)).toEqual(['qa'])
      const deleted = await send('DELETE', `/boards/${board.id}/labels/qa`)
      expect(deleted.body).toEqual({ ticketsTouched: 1, labels: [] })
      // Changing a board's vocabulary is an administrator's, and the token is the ceiling.
      await expect(send('POST', `/boards/${board.id}/categories`, { body: { name: 'Nope' }, scopes: ['read', 'write'] })).rejects.toMatchObject({ statusCode: 403 })

      // And all of it is readable, with the read scope, from the structure log.
      const log = await send('GET', `/boards/${board.id}/structure-log`, { scopes: ['read'] })
      expect(log.body.entries.map((entry: { operation: string }) => entry.operation)).toEqual(['label.delete', 'label.rename', 'category.create', 'board.create'])
      expect(log.body.entries[0]).not.toHaveProperty('ip')
      expect(log.body.entries[0].principal).toEqual({ id: owner().id, firstName: 'Grace', lastName: 'Hopper' })
    })

    it('manages a workspace\'s ticket types', async () => {
      const workspaceId = db.listBoards()[0]!.workspaceId
      const created = await send('POST', `/workspaces/${workspaceId}/ticket-types`, { body: { name: 'Webinar', color: 'blue' } })
      expect(created).toMatchObject({ status: 201, body: { type: { name: 'Webinar', color: 'blue', icon: { kind: 'lucide', name: 'Ticket' } } } })
      const typeId = created.body.type.id
      expect((await send('PATCH', `/ticket-types/${typeId}`, { body: { name: 'Seminar' } })).body.type.name).toBe('Seminar')
      const { types } = (await send('GET', `/workspaces/${workspaceId}/ticket-types`)).body
      const reversed = types.map((type: { id: string }) => type.id).reverse()
      expect((await send('PATCH', `/workspaces/${workspaceId}/ticket-type-order`, { body: { typeIds: reversed } })).body.types.map((type: { id: string }) => type.id)).toEqual(reversed)
      expect((await send('DELETE', `/ticket-types/${typeId}`)).status).toBe(204)
      await expect(send('PATCH', `/ticket-types/${typeId}`, { body: { name: 'Gone' } })).rejects.toMatchObject({ statusCode: 404 })
    })
  })
})
