import type { ZodType } from 'zod'
import type { BoardRole, Ticket, TicketComment } from '../../shared/types/domain'
import type { Actor } from '../utils/actor'
import type { UserRecord } from '../utils/db'

/**
 * What has to be true before an operation runs, and what resolving it leaves behind.
 *
 * Every scope reads `actor.principal` and nothing else — an agent's name never enters the
 * decision. The id functions pull the subject out of the already-validated input, so an
 * operation cannot accidentally check one board and act on another.
 */
export type Requirement<I> =
  | { scope: 'authenticated' }
  | { scope: 'instance' }
  | { scope: 'board'; role?: BoardRole; boardId: (input: I) => string }
  | { scope: 'ticket'; role?: BoardRole; ticketId: (input: I) => string }
  | { scope: 'comment'; commentId: (input: I) => string }

export interface OperationContext {
  actor: Actor
  /** The principal, under the name the rest of the codebase already uses. */
  account: UserRecord
  /** The board role the requirement resolved, or null for instance-scoped operations. */
  role: BoardRole | null
  boardId: string | null
  ticket: Ticket | null
  comment: TicketComment | null
}

/**
 * What this operation puts in the audit log.
 *
 * `changes` is an **allowlist**, never the whole input. That is what keeps a private key, a
 * password or an invite token out of the log by construction rather than by remembering: a
 * field nobody listed cannot reach it. Pass a function for anything that needs shaping.
 */
export interface AuditSpec<I> {
  targetType: string
  targetId?: (input: I, result: unknown) => string | null
  changes?: ReadonlyArray<keyof I & string> | ((input: I, result: unknown) => Record<string, unknown>)
}

export interface Operation<I = unknown, O = unknown> {
  /** Dotted and stable — it is the audit key, the REST route target and the MCP tool source. */
  name: string
  summary: string
  input: ZodType<I>
  requires: Requirement<I>
  /** `false` for reads, which would otherwise bury the writes worth finding. */
  audit: AuditSpec<I> | false
  run: (ctx: OperationContext, input: I) => O | Promise<O>
}

/**
 * Identity at runtime; the job is inference. `I` comes from `input` and is pinned with
 * `NoInfer` everywhere else, so a `requires` or `audit` that names a field the schema does
 * not have is a compile error.
 *
 * The result type is deliberately *not* inferred. Threading it through `audit` as well as
 * `run` makes TypeScript give up on both — inference through `ZodType` defers `run`, and the
 * audit spec then reads `unknown`. Since the only thing an audit spec ever does with a result
 * is pull an id out of it, `createdId` below covers that case safely instead.
 */
export function defineOperation<I>(operation: {
  name: string
  summary: string
  input: ZodType<I>
  requires: Requirement<NoInfer<I>>
  audit: AuditSpec<NoInfer<I>> | false
  run: (ctx: OperationContext, input: NoInfer<I>) => unknown
}): Operation<I> {
  return operation as Operation<I>
}

/**
 * The audit target for an operation that names the thing it just created — `board.create`
 * cannot know the id before it runs. Reads `result.<key>.id`, and yields null rather than
 * throwing if the operation returned something else: a surprise here should cost an id in
 * one log entry, never the request.
 */
export function createdId(key: string) {
  return (_input: unknown, result: unknown): string | null => {
    const value = (result as Record<string, { id?: unknown }> | null | undefined)?.[key]
    return typeof value?.id === 'string' ? value.id : null
  }
}
