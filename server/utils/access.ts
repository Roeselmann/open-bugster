import { createError } from 'h3'
import type { BoardRole } from '../../shared/types/domain'
import type { Actor } from './actor'
import { ceilingFor } from './token'
import { boardMembers, boardRoleFor, findBoard, findComment, findTicket, type UserRecord } from './db'

const rank: Record<BoardRole, number> = { viewer: 0, editor: 1, admin: 2 }

/** Whether a held board role covers what an endpoint asks for. */
export function satisfiesRole(held: BoardRole, minimum: BoardRole): boolean {
  return rank[held] >= rank[minimum]
}

export function isInstanceAdmin(account: UserRecord): boolean {
  return account.role === 'owner' || account.role === 'admin'
}

/**
 * Every check below reads `actor.principal` and never `actor.agentId`. That is the whole
 * guarantee behind letting agents in: an agent's reach is exactly its principal's reach,
 * and the agent's name is provenance that the history records but authorization ignores.
 *
 * A credential can only narrow that. `actor.scopes` is a ceiling applied *after* the
 * principal's own role is worked out, so a token never adds anything — the two failure modes
 * it prevents are a read-only token writing, and a token pinned to one board reaching another.
 */
export function requireInstanceAdmin(actor: Actor): UserRecord {
  if (!isInstanceAdmin(actor.principal)) throw createError({ statusCode: 403, statusMessage: 'This action is reserved for administrators.' })
  // Instance administration is the whole instance, so a board-pinned credential is out, and
  // anything short of the `admin` scope is too.
  if (actor.scopes && !actor.scopes.includes('admin')) {
    throw createError({ statusCode: 403, statusMessage: 'This token is not permitted to administer the instance.' })
  }
  if (actor.boardScope) {
    throw createError({ statusCode: 403, statusMessage: 'This token is limited to a single board.' })
  }
  return actor.principal
}

/** The role an actor effectively holds on a board, once its credential has had its say. */
function effectiveRole(actor: Actor, held: BoardRole): BoardRole | null {
  if (!actor.scopes) return held
  const ceiling = ceilingFor(actor.scopes)
  if (!ceiling) return null
  return satisfiesRole(held, ceiling) ? ceiling : held
}

export function boardViewer(account: UserRecord) {
  return { userId: account.id, instanceAdmin: isInstanceAdmin(account) }
}

/**
 * Resolves what the caller may do on a board.
 *
 * No membership at all reads as 404 rather than 403 on purpose — someone who cannot see a
 * board should not be able to learn that it exists by probing ids. A member who is merely
 * ranked too low gets a 403, because for them the board is not a secret.
 *
 * `account` is `actor.principal` under the name the routes already use; both are returned so
 * a caller can hand the actor on to a mutator without unpacking it again.
 */
export function requireBoardAccess(actor: Actor, boardId: string, minimum: BoardRole = 'viewer'): { actor: Actor; account: UserRecord; role: BoardRole } {
  const account = actor.principal
  if (!findBoard(boardId)) throw createError({ statusCode: 404, statusMessage: 'Board not found.' })
  // A credential pinned elsewhere is told the same thing a non-member is told: nothing.
  if (actor.boardScope && actor.boardScope !== boardId) throw createError({ statusCode: 404, statusMessage: 'Board not found.' })
  // Same rule as the board summary reports, so what the UI enables is what the API allows.
  const held: BoardRole | null = isInstanceAdmin(account) ? 'admin' : boardRoleFor(boardId, account.id)
  if (!held) throw createError({ statusCode: 404, statusMessage: 'Board not found.' })
  const role = effectiveRole(actor, held)
  if (!role || !satisfiesRole(role, minimum)) throw createError({ statusCode: 403, statusMessage: 'You do not have permission to do this.' })
  return { actor, account, role }
}

/** The same check, reached through a ticket rather than a board id. */
export function requireTicketAccess(actor: Actor, ticketId: string, minimum: BoardRole = 'viewer') {
  const ticket = findTicket(ticketId)
  if (!ticket) throw createError({ statusCode: 404, statusMessage: 'Ticket not found.' })
  const { account, role } = requireBoardAccess(actor, ticket.boardId, minimum)
  // The archive belongs to the board's administrators. To everybody else an archived ticket
  // reads as gone rather than as forbidden: it has left their board, and holding on to its
  // id is not a way to keep reading it, its comments, or its history.
  if (ticket.archivedAt && role !== 'admin') throw createError({ statusCode: 404, statusMessage: 'Ticket not found.' })
  return { actor, account, role, ticket }
}

/** The people a ticket on this board may be assigned to, or attributed to. */
export function boardMemberIds(boardId: string): Set<string> {
  return new Set(boardMembers(boardId).map(member => member.userId))
}

/**
 * Editing or removing a comment is for whoever wrote it, plus the board's admins — who
 * need a way to clear something out when its author is gone.
 */
export function requireCommentAccess(actor: Actor, commentId: string) {
  const comment = findComment(commentId)
  if (!comment) throw createError({ statusCode: 404, statusMessage: 'Comment not found.' })
  const { account, role } = requireTicketAccess(actor, comment.ticketId)
  const isAuthor = Boolean(comment.authorId) && comment.authorId === account.id
  if (!isAuthor && role !== 'admin') {
    throw createError({ statusCode: 403, statusMessage: 'Only the author can change this comment.' })
  }
  return { actor, account, role, comment }
}
