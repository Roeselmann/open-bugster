import { createError } from 'h3'
import { requireBoardAccess, requireCommentAccess, requireInstanceAdmin, requireTicketAccess } from '../utils/access'
import type { Actor } from '../utils/actor'
import { writeAudit, type AuditResult } from '../utils/audit'
import { validationError } from '../utils/validation'
import type { AuditSpec, Operation, OperationContext } from './types'

export interface RunOptions {
  /** Recorded on the audit entry when the caller knows it. */
  ip?: string | null
}

/**
 * Runs one operation: validate, resolve access, execute, record.
 *
 * The recording is the point. Because every mutation reaches the database through here, an
 * operation cannot be added that forgets to log — and the entry is identical whether the call
 * came from the browser, from a script, or from an agent. Wiring `writeAudit` into each route
 * by hand is exactly the pattern this exists to remove.
 *
 * Refusals are logged too. Somebody probing for boards they cannot see is the thing an audit
 * trail is for, and it leaves no other trace.
 */
export async function run<I, O>(operation: Operation<I, O>, actor: Actor, rawInput: unknown, options: RunOptions = {}): Promise<O> {
  const parsed = operation.input.safeParse(rawInput)
  if (!parsed.success) throw validationError(parsed.error)
  const input = parsed.data

  let context: OperationContext
  try {
    context = resolveAccess(operation, actor, input)
  } catch (error) {
    // No context yet, so the entry carries what we do know: who asked, and for what.
    record(operation, actor, input, undefined as O, 'denied', null, options)
    throw error
  }

  try {
    const result = await operation.run(context, input)
    record(operation, actor, input, result, 'ok', context.boardId, options)
    return result
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode
    record(operation, actor, input, undefined as O, status && status < 500 ? 'denied' : 'error', context.boardId, options)
    throw error
  }
}

function resolveAccess<I, O>(operation: Operation<I, O>, actor: Actor, input: I): OperationContext {
  const base: OperationContext = { actor, account: actor.principal, role: null, boardId: null, ticket: null, comment: null }
  const requires = operation.requires

  switch (requires.scope) {
    case 'authenticated':
      return base

    case 'instance':
      requireInstanceAdmin(actor)
      return base

    case 'board': {
      const boardId = (requires.boardId as (value: I) => string)(input)
      const { role } = requireBoardAccess(actor, boardId, requires.role)
      return { ...base, role, boardId }
    }

    case 'ticket': {
      const ticketId = (requires.ticketId as (value: I) => string)(input)
      const { role, ticket } = requireTicketAccess(actor, ticketId, requires.role)
      return { ...base, role, boardId: ticket.boardId, ticket }
    }

    case 'comment': {
      const commentId = (requires.commentId as (value: I) => string)(input)
      const { role, comment } = requireCommentAccess(actor, commentId)
      const { ticket } = requireTicketAccess(actor, comment.ticketId)
      return { ...base, role, boardId: ticket.boardId, ticket, comment }
    }
  }
}

function record<I, O>(operation: Operation<I, O>, actor: Actor, input: I, result: O, outcome: AuditResult, boardId: string | null, options: RunOptions) {
  const spec = operation.audit
  // Reads are not logged; they would bury the writes worth finding. A refused read is, though,
  // because being told no is the thing somebody probing for boards would leave behind.
  if (spec === false && outcome === 'ok') return

  const shape: AuditSpec<I> = spec === false ? { targetType: 'operation' } : spec
  writeAudit({
    actor,
    operation: operation.name,
    targetType: shape.targetType,
    targetId: shape.targetId?.(input, result) ?? null,
    boardId,
    changes: outcome === 'ok' ? selectChanges(shape, input, result) : {},
    result: outcome,
    ip: options.ip ?? null
  })
}

/** Only what the operation named. A field nobody listed never reaches the log. */
function selectChanges<I>(spec: AuditSpec<I>, input: I, result: unknown): Record<string, unknown> {
  if (!spec.changes) return {}
  if (typeof spec.changes === 'function') return spec.changes(input, result)
  const picked: Record<string, unknown> = {}
  for (const key of spec.changes) {
    const value = (input as Record<string, unknown>)[key]
    if (value !== undefined) picked[key] = value
  }
  return picked
}

/** Turns a missing row into the 404 the routes have always returned. */
export function orNotFound<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw createError({ statusCode: 404, statusMessage: `${what} not found.` })
  return value
}
