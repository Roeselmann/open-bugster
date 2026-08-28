import type { H3Event } from 'h3'
import type { BoardRole } from '../../shared/types/domain'
import { boardMembers, boardRoleFor, findBoard, findComment, findTicket, type UserRecord } from './db'

declare module 'h3' {
  interface H3EventContext {
    /** The signed-in account, resolved fresh from the database by the auth middleware. */
    account?: UserRecord
  }
}

const rank: Record<BoardRole, number> = { viewer: 0, editor: 1, admin: 2 }

/** Whether a held board role covers what an endpoint asks for. */
export function satisfiesRole(held: BoardRole, minimum: BoardRole): boolean {
  return rank[held] >= rank[minimum]
}

export function requireAuthUser(event: H3Event): UserRecord {
  const account = event.context.account
  if (!account) throw createError({ statusCode: 401, statusMessage: 'Sign in to continue.' })
  return account
}

export function isInstanceAdmin(account: UserRecord): boolean {
  return account.role === 'owner' || account.role === 'admin'
}

export function requireInstanceAdmin(event: H3Event): UserRecord {
  const account = requireAuthUser(event)
  if (!isInstanceAdmin(account)) throw createError({ statusCode: 403, statusMessage: 'This action is reserved for administrators.' })
  return account
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
 */
export function requireBoardAccess(event: H3Event, boardId: string, minimum: BoardRole = 'viewer'): { account: UserRecord; role: BoardRole } {
  const account = requireAuthUser(event)
  if (!findBoard(boardId)) throw createError({ statusCode: 404, statusMessage: 'Board not found.' })
  // Same rule as the board summary reports, so what the UI enables is what the API allows.
  const role: BoardRole | null = isInstanceAdmin(account) ? 'admin' : boardRoleFor(boardId, account.id)
  if (!role) throw createError({ statusCode: 404, statusMessage: 'Board not found.' })
  if (!satisfiesRole(role, minimum)) throw createError({ statusCode: 403, statusMessage: 'You do not have permission to do this.' })
  return { account, role }
}

/** The same check, reached through a ticket rather than a board id. */
export function requireTicketAccess(event: H3Event, ticketId: string, minimum: BoardRole = 'viewer') {
  const ticket = findTicket(ticketId)
  if (!ticket) throw createError({ statusCode: 404, statusMessage: 'Ticket not found.' })
  const { account, role } = requireBoardAccess(event, ticket.boardId, minimum)
  return { account, role, ticket }
}

/** The addresses a ticket on this board may be assigned to. */
export function boardMemberEmails(boardId: string): Set<string> {
  return new Set(boardMembers(boardId).map(member => member.email.trim().toLowerCase()))
}

/**
 * Editing or removing a comment is for whoever wrote it, plus the board's admins — who
 * need a way to clear something out when its author is gone.
 */
export function requireCommentAccess(event: H3Event, commentId: string) {
  const comment = findComment(commentId)
  if (!comment) throw createError({ statusCode: 404, statusMessage: 'Comment not found.' })
  const { account, role } = requireTicketAccess(event, comment.ticketId)
  const isAuthor = comment.authorEmail.trim().toLowerCase() === account.email.trim().toLowerCase()
  if (!isAuthor && role !== 'admin') {
    throw createError({ statusCode: 403, statusMessage: 'Only the author can change this comment.' })
  }
  return { account, role, comment }
}
