import type { Operation } from './types'
import * as accounts from './accounts'
import * as attachments from './attachments'
import * as boardDomain from './board-domain'
import * as credentials from './credentials'
import * as webhooks from './webhooks'
import * as tickets from './tickets'

export { defineOperation, createdId } from './types'
export type { Operation, OperationContext, Requirement, AuditSpec } from './types'
export { run, orNotFound } from './run'
export * from './accounts'
export * from './attachments'
export * from './board-domain'
export * from './credentials'
export * from './webhooks'
export * from './tickets'

/**
 * Every operation by name.
 *
 * This is what phase 5 turns into an OpenAPI document and phase 6 draws its MCP tools from,
 * so the name of an operation is a published identifier: it is the audit key, the REST route
 * target and the tool source at once. Renaming one is a breaking change.
 */
export const operations: ReadonlyMap<string, AnyOperation> = new Map(
  [...Object.values(accounts), ...Object.values(attachments), ...Object.values(boardDomain), ...Object.values(credentials), ...Object.values(tickets), ...Object.values(webhooks)]
    .filter(isOperation)
    .map(operation => [operation.name, operation])
)

export function findOperation(name: string): AnyOperation | null {
  return operations.get(name) ?? null
}

/**
 * The registry is heterogeneous, so its value type has to erase the input.
 *
 * `ZodType` is invariant in its output type, which makes `Operation<never>` reject every real
 * operation. Erasing it costs nothing in practice: anybody reaching an operation *by name*
 * holds an unvalidated payload by definition, and `run` puts it through that operation's own
 * schema before anything sees it. The types that matter are enforced at `defineOperation`.
 */
export type AnyOperation = Operation<any>

function isOperation(value: unknown): value is AnyOperation {
  const candidate = value as Partial<AnyOperation> | null
  return Boolean(candidate && typeof candidate.name === 'string' && typeof candidate.run === 'function' && candidate.input)
}
