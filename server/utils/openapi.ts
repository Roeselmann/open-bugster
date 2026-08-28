import { z } from 'zod'
import { v1Routes, type V1Route } from '~~/server/api/v1/routes'

/**
 * The OpenAPI document, generated from the same table the router dispatches from.
 *
 * Nothing here is hand-written per endpoint, so the spec cannot describe a route that does not
 * exist or miss one that does. Request schemas come straight from the operations' own zod
 * schemas through `z.toJSONSchema` — the same schemas that validate the request at runtime.
 *
 * OpenAPI **3.1** specifically: it is a superset of JSON Schema 2020-12, which is what zod
 * emits. Targeting 3.0 would mean hand-translating every schema into its older divergent
 * dialect, and getting nullability subtly wrong in the process.
 */
export function buildOpenApiDocument(origin: string) {
  const registry: Record<string, unknown> = {}
  const paths: Record<string, Record<string, unknown>> = {}

  for (const route of v1Routes) {
    const path = route.path.replace(/\{(\w+)\}/g, '{$1}')
    paths[path] ??= {}
    paths[path]![route.method.toLowerCase()] = operationObject(route, registry)
  }

  inlineAnonymous(registry, paths)

  return {
    openapi: '3.1.0',
    info: {
      title: 'Open-Bugster API',
      version: '1.0.0',
      description: [
        'The public API for a self-hosted Open-Bugster instance.',
        '',
        'Authenticate with a personal or service token: `Authorization: Bearer bgs_…`.',
        'A token is a ceiling on what its principal can already do, never a grant — a token',
        'with `write` scope held by a board viewer still cannot write.',
        '',
        'Errors are `application/problem+json` (RFC 9457) with a stable `type`.',
        'Send an `Idempotency-Key` header on any write to make a retry safe.'
      ].join('\n')
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'An Open-Bugster API token.' }
      },
      schemas: { ...registry, Problem: problemSchema }
    },
    paths
  }
}

function operationObject(route: V1Route, registry: Record<string, unknown>) {
  const { operation } = route
  const inputSchema = jsonSchemaOf(operation.input, registry)
  const pathParams = [...route.path.matchAll(/\{(\w+)\}/g)].map(match => match[1]!)
  // A discriminated union — `lane.delete` is one — has no top-level `properties`; its fields
  // live in the branches. Merging them gives the path and query parameters something to be
  // described by, while the body below keeps the union intact so the branches stay visible.
  const branches = branchesOf(inputSchema)
  const properties = mergedProperties(inputSchema, branches)
  const required = new Set(requiredAcross(inputSchema, branches))

  const parameters: Array<{ name: string; in: string; required: boolean; schema: unknown; description?: string }> =
    pathParams.map(name => ({
      name,
      in: 'path',
      required: true,
      schema: properties[name] ?? { type: 'string' }
    }))

  // Everything the body cannot carry becomes a query parameter.
  const bodyless = route.method === 'GET' || route.method === 'DELETE'
  if (bodyless) {
    for (const [name, schema] of Object.entries(properties)) {
      if (pathParams.includes(name)) continue
      parameters.push({ name, in: 'query', required: required.has(name), schema })
    }
  }

  const bodyProperties = Object.fromEntries(
    Object.entries(properties).filter(([name]) => !pathParams.includes(name))
  )
  // A union body is published as the union, so a caller can see that `mode: "move"` is the
  // branch that also needs `targetLaneId`.
  const bodySchema = branches.length
    ? { anyOf: branches.map(branch => withoutPathParams(branch, pathParams)) }
    : {
        type: 'object',
        properties: bodyProperties,
        required: [...required].filter(name => !pathParams.includes(name))
      }

  const responses: Record<string, unknown> = {
    [String(route.status ?? 200)]: route.status === 204
      ? { description: 'Done. No content.' }
      : {
          description: 'Success',
          content: { 'application/json': { schema: route.response ? refOrInline(route.response, registry) : { type: 'object' } } }
        }
  }
  // Inlined rather than referenced through `components.responses`, so a generator that only
  // resolves `components.schemas` still gets the whole picture.
  for (const status of [401, 403, 404, 422, 429]) {
    responses[String(status)] = {
      description: problemDescriptions[status],
      content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } }
    }
  }

  const result: Record<string, unknown> = {
    operationId: operation.name.replace(/\.(\w)/g, (_m, c: string) => c.toUpperCase()),
    summary: operation.summary,
    tags: [operation.name.split('.')[0]],
    parameters,
    responses
  }

  if (!bodyless) {
    result.requestBody = {
      required: branches.length > 0 || Object.keys(bodyProperties).length > 0,
      content: { 'application/json': { schema: bodySchema } }
    }
    result.parameters = [
      ...parameters,
      {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: { type: 'string' },
        description: 'Repeat a request safely: the first response is replayed instead of acting twice.'
      }
    ]
  }

  return result
}

const problemDescriptions: Record<number, string> = {
  401: 'No valid token was presented.',
  403: 'The principal, or the token’s scopes, do not permit this.',
  404: 'No such thing — or nothing this principal is allowed to see.',
  422: 'The request did not match the schema.',
  429: 'Rate limited. See Retry-After.'
}

const problemSchema = {
  type: 'object',
  description: 'RFC 9457 problem document.',
  properties: {
    type: { type: 'string', description: 'Stable identifier for the kind of failure.' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    errors: { type: 'object', additionalProperties: true },
    instance: { type: 'string' }
  },
  required: ['type', 'title', 'status']
}

/** Names the schema in `components` when it has one, so the document stays readable. */
function refOrInline(schema: z.ZodType, registry: Record<string, unknown>): unknown {
  return jsonSchemaOf(schema, registry)
}

function jsonSchemaOf(schema: z.ZodType, registry?: Record<string, unknown>): { properties?: unknown; required?: unknown; [key: string]: unknown } {
  const produced = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
    // Anything registered with an id, plus anything reused, becomes a `$defs` entry instead of
    // being expanded inline at every occurrence.
    reused: 'ref'
  }) as Record<string, unknown>

  // `$schema` belongs on a standalone JSON Schema document, not on a subschema inside an
  // OpenAPI one, where some generators choke on it.
  delete produced.$schema

  // Before the definitions are lifted out, not after: a definition can reference another one
  // (`BoardSummary` names `LaneSummary`), and rewriting only the top level leaves every one of
  // those pointing at a `$defs` block that is about to stop existing.
  rewriteRefs(produced)

  // zod collects shared pieces under `$defs`; OpenAPI wants them in `components.schemas`.
  if (produced.$defs) {
    for (const [name, definition] of Object.entries(produced.$defs as Record<string, unknown>)) {
      const cleaned = definition as Record<string, unknown>
      delete cleaned.$schema
      // Every schema is generated identically, so a repeat is the same definition again.
      if (registry) registry[name] = cleaned
    }
    delete produced.$defs
  }
  return produced as { properties?: unknown; required?: unknown }
}

function rewriteRefs(node: unknown): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(rewriteRefs); return }
  const record = node as Record<string, unknown>
  if (typeof record.$ref === 'string' && record.$ref.startsWith('#/$defs/')) {
    record.$ref = record.$ref.replace('#/$defs/', '#/components/schemas/')
  }
  for (const value of Object.values(record)) rewriteRefs(value)
}


/**
 * Folds the unnamed schemas back where they came from.
 *
 * zod lifts *any* schema instance it sees twice into `$defs`, which for a codebase that shares
 * `const idSchema = z.string()` between validators means a run of `__schema0`, `__schema1`
 * entries that are each nothing but `{"type":"string"}`. Named types earn a place in
 * `components.schemas`; those do not, and a generated client full of `Schema0` aliases is
 * worse than no reuse at all.
 */
function inlineAnonymous(registry: Record<string, unknown>, paths: Record<string, unknown>) {
  const anonymous = Object.keys(registry).filter(name => /^__schema\d+$/.test(name))
  if (!anonymous.length) return

  // Snapshotted before anything is removed: the loop below deletes as it goes, and a
  // definition still being referenced must not vanish out from under the resolver.
  const definitions = new Map(anonymous.map(name => [name, registry[name]]))

  const resolve = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(resolve)
    const record = node as Record<string, unknown>
    const ref = typeof record.$ref === 'string' ? record.$ref.replace('#/components/schemas/', '') : null
    if (ref && definitions.has(ref)) {
      // Cloned, so two occurrences do not end up sharing one object.
      return resolve(JSON.parse(JSON.stringify(definitions.get(ref))))
    }
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, resolve(value)]))
  }

  for (const [path, item] of Object.entries(paths)) paths[path] = resolve(item)
  for (const [name, schema] of Object.entries(registry)) {
    if (definitions.has(name)) delete registry[name]
    else registry[name] = resolve(schema)
  }
}


/** The branches of a union input, or nothing for an ordinary object. */
function branchesOf(schema: Record<string, unknown>): Array<Record<string, unknown>> {
  const union = (schema.anyOf ?? schema.oneOf) as Array<Record<string, unknown>> | undefined
  return Array.isArray(union) ? union : []
}

/** Every field any branch can carry, so path and query parameters can be described. */
function mergedProperties(schema: { properties?: unknown }, branches: Array<Record<string, unknown>>): Record<string, unknown> {
  if (!branches.length) return (schema.properties ?? {}) as Record<string, unknown>
  const merged: Record<string, unknown> = {}
  for (const branch of branches) {
    for (const [name, definition] of Object.entries((branch.properties ?? {}) as Record<string, unknown>)) {
      merged[name] ??= definition
    }
  }
  return merged
}

/** Only what *every* branch demands is truly required of the request. */
function requiredAcross(schema: { required?: unknown }, branches: Array<Record<string, unknown>>): string[] {
  if (!branches.length) return (schema.required ?? []) as string[]
  const lists = branches.map(branch => new Set((branch.required ?? []) as string[]))
  if (!lists.length) return []
  return [...lists[0]!].filter(name => lists.every(list => list.has(name)))
}

function withoutPathParams(branch: Record<string, unknown>, pathParams: string[]): Record<string, unknown> {
  const properties = Object.fromEntries(
    Object.entries((branch.properties ?? {}) as Record<string, unknown>).filter(([name]) => !pathParams.includes(name))
  )
  return {
    ...branch,
    properties,
    required: ((branch.required ?? []) as string[]).filter(name => !pathParams.includes(name))
  }
}
