import { copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createError } from 'h3'
import { z } from 'zod'
import { AppleApiError, syncTestFlight, verifyTestFlightAccess } from '../utils/app-store-connect'
import { JiraApiError, syncJira, verifyJiraAccess } from '../utils/jira'
import { tokenLabel } from '../utils/jira-policy'
import { getServerConfig } from '../utils/config'
import { SecretBoxError } from '../utils/secret-box'
import { boardViewer, isInstanceAdmin, requireWorkspaceAccess } from '../utils/access'
import { listAudit, listBoardStructureAudit } from '../utils/audit'
import {
  BoardNotEmptyError, CategoryNameTakenError, LaneDeleteError, boardMembers, boardRoleFor, countBoardAdmins, countBoards,
  createBoard, createCategory, createComment, createLane, defaultWorkspaceId, deleteBoard, deleteCategory, deleteComment, deleteLabel, deleteLane, duplicateBoard, findBoard, findBoardSummary,
  renameLabel,
  boardJiraCredentials, boardSyncCredentials, clearBoardJiraToken, clearBoardPrivateKey, findCategory, findLane, importLaneFor, latestSyncRun, listBoards, listCategories, listComments, listLabels, listLanes,
  listAgents, listUsers, moveBoardToWorkspace, personById, removeBoardMember, reorderLanes, setBoardJiraToken, setBoardMember, setBoardPrivateKey, ticketTypeBelongsToBoard, updateBoard, updateCategory, updateComment, updateLane
} from '../utils/db'
import {
  boardCreateSchema, boardMemberSchema, boardUpdateSchema, categoryUpdateSchema, commentSaveSchema, connectionTestSchema,
  importRequestSchema, jiraConnectionTestSchema, jiraTokenSchema, labelNameSchema, laneCreateSchema, laneOrderSchema, laneUpdateSchema
} from '../utils/validation'
import { categoryColors } from '../../shared/types/domain'
import { createdId, defineOperation, type OperationContext } from './types'
import { orNotFound } from './run'

const id = z.string().trim().min(1).max(64)
const boardOf = (input: { boardId: string }) => input.boardId

/* ── boards ─────────────────────────────────────────────────────────────── */

export const boardList = defineOperation({
  name: 'board.list',
  summary: 'List the boards the caller can see',
  input: z.object({}),
  requires: { scope: 'authenticated' },
  audit: false,
  // Board access itself is checked per board; this only keeps the listing honest, so an agent
  // is not shown boards every later call would refuse it.
  run: ctx => ({ boards: automatable(listBoards(boardViewer(ctx.account)), ctx) })
})

/** The boards this context may actually work, once the channel has had its say. */
function automatable(boards: BoardSummary[], ctx: OperationContext): BoardSummary[] {
  if (ctx.actor.channel === 'web' || isInstanceAdmin(ctx.account)) return boards
  return boards.filter(board => board.members.some(member => member.userId === ctx.account.id && member.mayAutomate))
}

export const boardGet = defineOperation({
  name: 'board.get',
  summary: 'Read one board with its lanes and members',
  input: z.object({ boardId: id }),
  requires: { scope: 'board', role: 'viewer', boardId: boardOf },
  audit: false,
  run: (ctx, input) => ({ board: orNotFound(findBoardSummary(input.boardId, boardViewer(ctx.account)), 'Board') })
})

export const boardCreate = defineOperation({
  name: 'board.create',
  summary: 'Open a new board',
  // `description` and `lanes` came later and are optional, so a client that sends only a name
  // still gets the seeded lanes it always did. They live here rather than on the shared
  // schema because `board.duplicate` extends that one and copies its lanes from the source.
  input: boardCreateSchema.extend({
    description: boardUpdateSchema.shape.description.unwrap().optional(),
    lanes: z.array(laneCreateSchema).min(1).max(30).optional()
      .describe('The board\'s lanes, left to right, instead of the default Import, Backlog, In Progress and Done. None of them is an import lane. A lane with isLive is not also isDone.')
  }),
  // Was instance-scoped before workspaces existed. A workspace admin opens boards in their
  // own workspace now; an omitted id resolves to the default workspace, so pre-workspace
  // clients keep working — and instance admins pass either way, as they always did.
  requires: { scope: 'workspace', role: 'admin', workspaceId: input => input.workspaceId ?? defaultWorkspaceId() },
  audit: {
    targetType: 'board',
    targetId: createdId('board'),
    changes: input => ({
      name: input.name,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.lanes ? { lanes: input.lanes.map(lane => lane.name) } : {})
    })
  },
  run: (ctx, input) => ({
    board: createBoard(input.name, ctx.account.id, input.workspaceId ?? defaultWorkspaceId(), { description: input.description, lanes: input.lanes })
  })
})

export const boardUpdate = defineOperation({
  name: 'board.update',
  summary: 'Change a board’s name, description or sync settings',
  input: boardUpdateSchema.extend({ boardId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  // The App Store Connect ids are configuration, not secrets — the private key never passes
  // through this operation at all, and could not be logged even by mistake.
  audit: { targetType: 'board', targetId: input => input.boardId, changes: input => ({ fields: changedFields(input, 'boardId') }) },
  run: (ctx, input) => {
    const { boardId, ...fields } = input
    if (fields.importTypeId && !ticketTypeBelongsToBoard(fields.importTypeId, boardId)) {
      throw createError({ statusCode: 422, statusMessage: 'A ticket type must belong to this board’s workspace.' })
    }
    return { board: orNotFound(updateBoard(boardId, fields, boardViewer(ctx.account)), 'Board') }
  }
})

export const boardMove = defineOperation({
  name: 'board.move',
  summary: 'Move a board into another workspace',
  input: z.object({ boardId: id, workspaceId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'board', targetId: input => input.boardId, changes: ['workspaceId'] },
  run: (ctx, input) => {
    // Placing a board in a workspace is what `board.create` guards, so the destination asks
    // for the same right — on top of the board-admin requirement above. Membership travels
    // with the board, so the move itself changes nobody's access to anything.
    requireWorkspaceAccess(ctx.actor, input.workspaceId, 'admin')
    const board = orNotFound(findBoard(input.boardId), 'Board')
    if (board.workspaceId === input.workspaceId) {
      throw createError({ statusCode: 409, statusMessage: 'The board is already in this workspace.' })
    }
    return { board: orNotFound(moveBoardToWorkspace(input.boardId, input.workspaceId, boardViewer(ctx.account)), 'Board') }
  }
})

export const boardDuplicate = defineOperation({
  name: 'board.duplicate',
  summary: 'Copy a board, with or without its tickets',
  input: boardCreateSchema.extend({ boardId: id, includeTickets: z.boolean().default(false) }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'board', targetId: createdId('board'), changes: ['name', 'workspaceId', 'includeTickets'] },
  run: async (ctx, input) => {
    const source = orNotFound(findBoard(input.boardId), 'Board')
    // An omitted target duplicates in place; naming one is subject to the same right as
    // opening a board there by hand.
    const workspaceId = input.workspaceId ?? source.workspaceId
    requireWorkspaceAccess(ctx.actor, workspaceId, 'admin')
    const result = orNotFound(
      duplicateBoard(input.boardId, { name: input.name, workspaceId, includeTickets: input.includeTickets, creatorId: ctx.account.id }),
      'Board'
    )
    // After the commit, best effort per file: the transaction is synchronous, the filesystem
    // is not, and a missing file costs one download rather than the whole copy.
    const root = resolve(getServerConfig().attachmentsPath)
    for (const copy of result.attachmentCopies) {
      try {
        await mkdir(dirname(join(root, copy.to)), { recursive: true })
        await copyFile(join(root, copy.from), join(root, copy.to))
      } catch (error) {
        console.warn(`[open-bugster] could not copy attachment ${copy.from}:`, (error as Error).message)
      }
    }
    return { board: result.board }
  }
})

export const boardDelete = defineOperation({
  name: 'board.delete',
  summary: 'Delete a board and everything on it',
  input: z.object({
    boardId: id,
    // Off by default, which is how this operation always behaved. The MCP tool always sets it:
    // an agent tidying up should never be one call away from deleting somebody's tickets.
    onlyIfEmpty: z.boolean().default(false)
      .describe('Refuse with 409 while the board holds any ticket, archived ones included.')
  }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'board', targetId: input => input.boardId, changes: input => (input.onlyIfEmpty ? { onlyIfEmpty: true } : {}) },
  run: async (_ctx, input) => {
    if (countBoards() <= 1) throw createError({ statusCode: 409, statusMessage: 'The last board cannot be deleted.' })
    let deleted: { ticketIds: string[] } | null
    try {
      deleted = deleteBoard(input.boardId, { onlyIfEmpty: input.onlyIfEmpty })
    } catch (error) {
      if (error instanceof BoardNotEmptyError) throw createError({ statusCode: 409, statusMessage: error.message })
      throw error
    }
    const { ticketIds } = orNotFound(deleted, 'Board')
    // The attachments belong to the tickets that just went, so clearing them belongs here
    // rather than in a route — every surface that can delete a board owes the same cleanup.
    // The rows are gone either way; a leftover folder beats failing the request.
    const root = resolve(getServerConfig().attachmentsPath)
    await Promise.all(ticketIds.map(ticketId => rm(join(root, ticketId), { recursive: true, force: true }).catch(() => undefined)))
    return null
  }
})

/** Turns what a sync or connection test threw into the HTTP error the caller should see. */
function integrationFailure(error: unknown, fallback: string): never {
  if (error instanceof AppleApiError || error instanceof JiraApiError) throw createError({ statusCode: error.statusCode, statusMessage: error.message })
  if (error instanceof SecretBoxError) throw createError({ statusCode: 500, statusMessage: error.message })
  throw createError({ statusCode: 500, statusMessage: error instanceof Error ? error.message : fallback })
}

export const importRun = defineOperation({
  name: 'import.run',
  summary: 'Pull the newest items of one of a board’s connections — TestFlight or Jira — onto it',
  input: importRequestSchema,
  // A sync spends the board's credentials and writes tickets into the import lane under the
  // board's own name, so it belongs to whoever owns those credentials.
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'board', targetId: input => input.boardId, changes: ['provider'] },
  run: async (_ctx, input) => {
    const importLane = importLaneFor(input.boardId)
    if (!importLane) throw createError({ statusCode: 409, statusMessage: 'This board has no import lane.' })
    const attachmentsPath = getServerConfig().attachmentsPath
    try {
      if (input.provider === 'jira') {
        const credentials = boardJiraCredentials(input.boardId)!
        return { run: await syncJira({ boardId: input.boardId, laneId: importLane.id, ...credentials, attachmentsPath }) }
      }
      const credentials = boardSyncCredentials(input.boardId)!
      return { run: await syncTestFlight({ boardId: input.boardId, laneId: importLane.id, ...credentials, attachmentsPath }) }
    } catch (error) {
      integrationFailure(error, `${input.provider === 'jira' ? 'Jira' : 'TestFlight'} sync failed.`)
    }
  }
})

/* ── lanes ──────────────────────────────────────────────────────────────── */

export const laneList = defineOperation({
  name: 'lane.list',
  summary: 'List a board’s lanes',
  input: z.object({ boardId: id }),
  requires: { scope: 'board', role: 'viewer', boardId: boardOf },
  audit: false,
  run: (_ctx, input) => ({ lanes: listLanes(input.boardId) })
})

export const laneCreate = defineOperation({
  name: 'lane.create',
  summary: 'Add a lane to a board',
  input: laneCreateSchema.extend({ boardId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'lane', targetId: createdId('lane'), changes: ['name', 'isDone', 'isLive'] },
  run: (_ctx, input) => {
    const lane = orNotFound(createLane(input.boardId, input.name, { isDone: input.isDone, isLive: input.isLive }), 'Board')
    return { lane, lanes: listLanes(input.boardId) }
  }
})

export const laneUpdate = defineOperation({
  name: 'lane.update',
  summary: 'Rename a lane, or mark whether it holds finished or live work',
  input: laneUpdateSchema.extend({ boardId: id, laneId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'lane', targetId: input => input.laneId, changes: ['name', 'isDone', 'isLive'] },
  run: (_ctx, input) => {
    laneOfBoard(input.laneId, input.boardId)
    updateLane(input.laneId, { name: input.name, isDone: input.isDone, isLive: input.isLive })
    return { lanes: listLanes(input.boardId) }
  }
})

export const laneReorder = defineOperation({
  name: 'lane.reorder',
  summary: 'Set the order of a board’s lanes',
  input: laneOrderSchema.extend({ boardId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'board', targetId: input => input.boardId, changes: ['laneIds'] },
  run: (_ctx, input) => {
    const lanes = reorderLanes(input.boardId, input.laneIds)
    if (!lanes) throw createError({ statusCode: 422, statusMessage: 'The new order must list every lane of this board exactly once.' })
    return { lanes }
  }
})

export const laneDelete = defineOperation({
  name: 'lane.delete',
  summary: 'Remove a lane, archiving or moving what is on it',
  input: z.discriminatedUnion('mode', [
    z.object({ boardId: id, laneId: id, mode: z.literal('move'), targetLaneId: id }),
    z.object({ boardId: id, laneId: id, mode: z.literal('archive') }),
    // Checked inside the deleting transaction, so a ticket landing meanwhile is not swept along.
    z.object({ boardId: id, laneId: id, mode: z.literal('empty').describe('Delete only a lane holding no open tickets; 409 otherwise.') })
  ]),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  // The name goes into the log because the lane is gone afterwards: an entry that only held
  // its id would tell a reader of the board's history nothing.
  audit: { targetType: 'lane', targetId: input => input.laneId, changes: (input, result) => ({ mode: input.mode, ...deletedName(result) }) },
  run: (_ctx, input) => {
    const lane = laneOfBoard(input.laneId, input.boardId)
    try {
      return {
        lanes: deleteLane(input.laneId, input.mode, input.mode === 'move' ? input.targetLaneId : undefined),
        deleted: { id: lane.id, name: lane.name }
      }
    } catch (error) {
      if (error instanceof LaneDeleteError) throw createError({ statusCode: error.statusCode, statusMessage: error.message })
      throw error
    }
  }
})

/* ── members ────────────────────────────────────────────────────────────── */

export const memberList = defineOperation({
  name: 'member.list',
  summary: 'List a board’s members',
  input: z.object({ boardId: id }),
  requires: { scope: 'board', role: 'viewer', boardId: boardOf },
  audit: false,
  run: (_ctx, input) => ({ members: boardMembers(input.boardId) })
})

export const memberCandidates = defineOperation({
  name: 'member.candidates',
  summary: 'List accounts that could still be added to a board',
  input: z.object({ boardId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: false,
  run: (_ctx, input) => {
    const existing = new Set(boardMembers(input.boardId).map(member => member.userId))
    return {
      candidates: [
        ...listUsers()
          // An anonymized account is a tombstone: it keeps its history and is offered to nobody.
          .filter(user => !existing.has(user.id) && !user.anonymizedAt)
          .map(user => ({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, status: user.status, isService: false })),
        // Agents join a board like anybody else; a disabled one would be a member who cannot act.
        ...listAgents()
          .filter(agent => !existing.has(agent.id) && agent.status === 'active')
          .map(agent => ({ id: agent.id, email: null, firstName: agent.name, lastName: '', status: agent.status, isService: true })),
      ]
    }
  }
})

export const memberSet = defineOperation({
  name: 'member.set',
  summary: 'Add somebody to a board, or change the role they hold',
  input: boardMemberSchema.extend({ boardId: id, userId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'user', targetId: input => input.userId, changes: ['role', 'mayAutomate'] },
  run: (ctx, input) => {
    // The same rule `member.remove` keeps: demoting the last administrator would leave the
    // board's settings reachable to instance administrators only.
    if (input.role !== 'admin' && boardRoleFor(input.boardId, input.userId) === 'admin' && countBoardAdmins(input.boardId) <= 1) {
      throw createError({ statusCode: 409, statusMessage: 'A board needs at least one administrator.' })
    }
    const member = setBoardMember(input.boardId, input.userId, input.role, input.mayAutomate)
    if (!member) throw createError({ statusCode: 404, statusMessage: 'This account does not exist.' })
    return { member, board: findBoardSummary(input.boardId, boardViewer(ctx.account)) }
  }
})

export const memberRemove = defineOperation({
  name: 'member.remove',
  summary: 'Take somebody off a board',
  input: z.object({ boardId: id, userId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'user', targetId: input => input.userId },
  run: (ctx, input) => {
    // Leaving a board without an admin would make its settings unreachable for everyone
    // except instance administrators.
    if (boardRoleFor(input.boardId, input.userId) === 'admin' && countBoardAdmins(input.boardId) <= 1) {
      throw createError({ statusCode: 409, statusMessage: 'A board needs at least one administrator.' })
    }
    if (!removeBoardMember(input.boardId, input.userId)) {
      throw createError({ statusCode: 404, statusMessage: 'This account is not a member of the board.' })
    }
    return { board: findBoardSummary(input.boardId, boardViewer(ctx.account)) }
  }
})

/* ── comments ───────────────────────────────────────────────────────────── */

export const commentList = defineOperation({
  name: 'comment.list',
  summary: 'Read a ticket’s comment thread',
  input: z.object({ ticketId: id }),
  requires: { scope: 'ticket', role: 'viewer', ticketId: input => input.ticketId },
  audit: false,
  run: (_ctx, input) => ({ comments: listComments(input.ticketId) })
})

export const commentAdd = defineOperation({
  name: 'comment.add',
  summary: 'Add a comment to a ticket',
  input: commentSaveSchema.extend({ ticketId: id }),
  // Viewers may join the conversation; only changing the ticket itself needs `editor`.
  requires: { scope: 'ticket', role: 'viewer', ticketId: input => input.ticketId },
  // The body is the person's own words; the log records that they spoke, not what they said.
  audit: { targetType: 'comment', targetId: createdId('comment') },
  run: (ctx, input) => ({
    comment: orNotFound(createComment(input.ticketId, ctx.actor.principalId, input.body, ctx.actor), 'Ticket')
  })
})

export const commentUpdate = defineOperation({
  name: 'comment.update',
  summary: 'Edit a comment',
  input: commentSaveSchema.extend({ commentId: id }),
  requires: { scope: 'comment', commentId: input => input.commentId },
  audit: { targetType: 'comment', targetId: input => input.commentId },
  run: (_ctx, input) => ({ comment: orNotFound(updateComment(input.commentId, input.body), 'Comment') })
})

export const commentRemove = defineOperation({
  name: 'comment.remove',
  summary: 'Delete a comment',
  input: z.object({ commentId: id }),
  requires: { scope: 'comment', commentId: input => input.commentId },
  audit: { targetType: 'comment', targetId: input => input.commentId },
  run: (_ctx, input) => {
    if (!deleteComment(input.commentId)) throw createError({ statusCode: 404, statusMessage: 'Comment not found.' })
    return null
  }
})

/* ── categories and labels ──────────────────────────────────────────────── */

export const categoryList = defineOperation({
  name: 'category.list',
  summary: 'List a board’s categories',
  input: z.object({ boardId: id }),
  requires: { scope: 'board', role: 'viewer', boardId: boardOf },
  audit: false,
  run: (_ctx, input) => ({ categories: listCategories(input.boardId) })
})

/**
 * A ticket naming a category it does not know opens one on the fly, always neutral. This is the
 * deliberate way: a name the board already has is refused rather than reused.
 */
export const categoryCreate = defineOperation({
  name: 'category.create',
  summary: 'Add a category to a board',
  input: z.object({
    boardId: id,
    name: categoryUpdateSchema.shape.name.unwrap(),
    color: z.enum(categoryColors).default('neutral')
  }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'category', targetId: createdId('category'), changes: ['name', 'color'] },
  run: (_ctx, input) => {
    try {
      return { category: orNotFound(createCategory(input.boardId, input.name, input.color), 'Board') }
    } catch (error) {
      if (error instanceof CategoryNameTakenError) throw createError({ statusCode: 409, statusMessage: error.message })
      throw error
    }
  }
})

export const categoryUpdate = defineOperation({
  name: 'category.update',
  summary: 'Rename or recolour a category',
  input: categoryUpdateSchema.extend({ categoryId: id }),
  requires: { scope: 'board', role: 'admin', boardId: input => categoryBoard(input.categoryId) },
  audit: { targetType: 'category', targetId: input => input.categoryId, changes: ['name', 'color'] },
  run: (_ctx, input) => {
    try {
      return { category: orNotFound(updateCategory(input.categoryId, input), 'Category') }
    } catch (error) {
      if (error instanceof CategoryNameTakenError) throw createError({ statusCode: 409, statusMessage: error.message })
      throw error
    }
  }
})

export const categoryDelete = defineOperation({
  name: 'category.delete',
  summary: 'Remove a category from a board',
  input: z.object({ categoryId: id }),
  requires: { scope: 'board', role: 'admin', boardId: input => categoryBoard(input.categoryId) },
  audit: { targetType: 'category', targetId: input => input.categoryId, changes: (_input, result) => deletedName(result) },
  run: (_ctx, input) => {
    const category = findCategory(input.categoryId)
    if (!category || !deleteCategory(input.categoryId)) throw createError({ statusCode: 404, statusMessage: 'Category not found.' })
    // Answered with 204 over REST; the name is here for the log, as with a deleted lane.
    return { deleted: { id: category.id, name: category.name } }
  }
})

export const labelList = defineOperation({
  name: 'label.list',
  summary: 'List a board’s labels',
  input: z.object({ boardId: id }),
  requires: { scope: 'board', role: 'viewer', boardId: boardOf },
  audit: false,
  run: (_ctx, input) => ({ labels: listLabels(input.boardId) })
})

/**
 * Labels have no settings page of their own — they come and go with the tickets that carry
 * them — so these two are the only way to tidy them up in bulk. Board admin, like every other
 * change to a board's vocabulary. Addressed by name, which is all a ticket ever shows.
 */
export const labelRename = defineOperation({
  name: 'label.rename',
  summary: 'Rename a board’s label, merging it into one that already has the new name',
  input: z.object({
    boardId: id,
    name: labelNameSchema.describe('The label as it is now; matched case-insensitively.'),
    newName: labelNameSchema.describe('Onto a name another label already has, the two merge: every ticket keeps the one label.')
  }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'label', targetId: (_input, result) => (result as { label?: { id?: string } } | null)?.label?.id ?? null, changes: ['name', 'newName'] },
  run: (_ctx, input) => {
    const change = orNotFound(renameLabel(input.boardId, input.name, input.newName), 'Label')
    return { ...change, labels: listLabels(input.boardId) }
  }
})

export const labelDelete = defineOperation({
  name: 'label.delete',
  summary: 'Take a label off every ticket of a board',
  input: z.object({ boardId: id, name: labelNameSchema.describe('Matched case-insensitively.') }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'label', changes: ['name'] },
  run: (_ctx, input) => {
    const change = orNotFound(deleteLabel(input.boardId, input.name), 'Label')
    return { ticketsTouched: change.ticketsTouched, labels: listLabels(input.boardId) }
  }
})

/* ── App Store Connect credentials ──────────────────────────────────────── */

/**
 * The PEM reaches this operation because storing it is the point, and it is kept out of the
 * audit log by the one mechanism that cannot be forgotten: `changes` is an allowlist, and
 * nobody listed it. Only the filename is recorded, which is what an administrator reading
 * the log later actually needs.
 */
export const boardKeySet = defineOperation({
  name: 'board.setKey',
  summary: 'Store a board’s App Store Connect private key',
  input: z.object({ boardId: id, filename: z.string().trim().min(1).max(255), pem: z.string().min(1) }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'board', targetId: input => input.boardId, changes: ['filename'] },
  run: (ctx, input) => ({
    board: orNotFound(setBoardPrivateKey(input.boardId, input.pem, input.filename, boardViewer(ctx.account)), 'Board')
  })
})

export const boardKeyClear = defineOperation({
  name: 'board.clearKey',
  summary: 'Remove a board’s App Store Connect private key',
  input: z.object({ boardId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'board', targetId: input => input.boardId },
  run: (ctx, input) => ({
    board: orNotFound(clearBoardPrivateKey(input.boardId, boardViewer(ctx.account)), 'Board')
  })
})

export const boardTestConnection = defineOperation({
  name: 'board.testConnection',
  summary: 'Check that a board’s App Store Connect credentials work',
  input: connectionTestSchema.extend({ boardId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  // A read against Apple rather than a change here, but worth an entry: it is the one call
  // that proves a stored key is live, and a burst of them is worth being able to see.
  audit: { targetType: 'board', targetId: input => input.boardId },
  run: async (_ctx, input) => {
    // The settings form may hold edits that were never saved, and testing the stored values
    // instead would answer a question nobody asked. Only the private key has to come from the
    // vault, because it is write-only and never leaves the server.
    const stored = boardSyncCredentials(input.boardId)!
    try {
      return {
        app: await verifyTestFlightAccess({
          ...stored,
          issuerId: input.issuerId ?? stored.issuerId,
          keyId: input.keyId ?? stored.keyId,
          appId: input.appId ?? stored.appId
        })
      }
    } catch (error) {
      integrationFailure(error, 'The connection test failed.')
    }
  }
})

/* ── jira ───────────────────────────────────────────────────────────────── */

export const jiraTokenSet = defineOperation({
  name: 'jira.setToken',
  summary: 'Store a board’s Jira API token',
  input: jiraTokenSchema.extend({ boardId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  // No `changes`: the only field is the token, and it must never reach the log.
  audit: { targetType: 'board', targetId: input => input.boardId },
  run: (ctx, input) => ({
    board: orNotFound(setBoardJiraToken(input.boardId, input.token, tokenLabel(input.token), boardViewer(ctx.account)), 'Board')
  })
})

export const jiraTokenClear = defineOperation({
  name: 'jira.clearToken',
  summary: 'Remove a board’s Jira API token',
  input: z.object({ boardId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'board', targetId: input => input.boardId },
  run: (ctx, input) => ({
    board: orNotFound(clearBoardJiraToken(input.boardId, boardViewer(ctx.account)), 'Board')
  })
})

export const jiraTestConnection = defineOperation({
  name: 'jira.testConnection',
  summary: 'Check that a board’s Jira credentials and JQL work',
  input: jiraConnectionTestSchema.extend({ boardId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'board', targetId: input => input.boardId },
  run: async (_ctx, input) => {
    // As with TestFlight: the form's draft values are what gets tested; only the token is
    // write-only and therefore always comes from the vault.
    const stored = boardJiraCredentials(input.boardId)!
    try {
      return {
        connection: await verifyJiraAccess({
          siteUrl: input.siteUrl ?? stored.siteUrl,
          email: input.email ?? stored.email,
          jql: input.jql ?? stored.jql,
          token: stored.token
        })
      }
    } catch (error) {
      integrationFailure(error, 'The connection test failed.')
    }
  }
})

/* ── import ─────────────────────────────────────────────────────────────── */

export const importStatus = defineOperation({
  name: 'import.status',
  summary: 'Read the most recent sync of one of a board’s connections',
  input: importRequestSchema,
  requires: { scope: 'board', role: 'viewer', boardId: boardOf },
  audit: false,
  run: (_ctx, input) => ({ run: latestSyncRun(input.boardId, input.provider) })
})

/* ── the audit trail ────────────────────────────────────────────────────── */

/**
 * A board's own slice of the audit log.
 *
 * Board admins only, and scoped to their board: the instance-level entries — accounts,
 * tokens, service identities — are not theirs to read, and a board admin is not necessarily
 * an instance administrator.
 */
export const auditList = defineOperation({
  name: 'audit.list',
  summary: 'Read what has been done on this board',
  input: z.object({
    boardId: id,
    operation: z.string().trim().max(64).optional(),
    principalId: id.optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional()
  }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: false,
  run: (_ctx, input) => {
    const entries = listAudit({
      boardId: input.boardId,
      operation: input.operation,
      principalId: input.principalId,
      limit: input.limit ?? 100,
      offset: input.offset
    })
    // The reader wants people, not ids; an id whose row is gone resolves to null rather than
    // showing a raw uuid, exactly as the ticket history does.
    return {
      entries: entries.map(entry => ({ ...entry, principal: personById(entry.principalId) }))
    }
  }
})

/**
 * What has been done to a board's shape — its name, lanes, people, categories and labels —
 * for anybody who can read the board.
 *
 * A separate read from `audit.list` rather than a looser rule on it: that one is the whole
 * log, refusals, channels and all, and stays with the board's administrators. This returns
 * only successful entries of the operations below, and of each only the fields its own audit
 * spec already allowlisted — never an IP, a token id, or an attempt somebody was refused.
 * Ticket changes are not here; the ticket history covers them.
 */
export const structureOperations = [
  'board.create', 'board.update',
  'lane.create', 'lane.update', 'lane.reorder', 'lane.delete',
  'member.set', 'member.remove',
  'category.create', 'category.update', 'category.delete',
  'label.rename', 'label.delete'
] as const

export const boardStructureList = defineOperation({
  name: 'board.structure.list',
  summary: 'Read how a board’s lanes, members, categories and labels were changed',
  input: z.object({
    boardId: id,
    since: z.string().trim().max(40).optional().describe('ISO timestamp; only entries at or after it.'),
    limit: z.number().int().min(1).max(200).optional()
  }),
  requires: { scope: 'board', role: 'viewer', boardId: boardOf },
  audit: false,
  run: (_ctx, input) => ({
    entries: listBoardStructureAudit(input.boardId, structureOperations, { since: input.since, limit: input.limit ?? 50 }).map(entry => ({
      operation: entry.operation,
      at: entry.at,
      // Who, by name only: the person directory carries an address, and a viewer reading the
      // board's history has no business with somebody's e-mail.
      principal: nameOnly(personById(entry.principalId)),
      agentId: entry.agentId,
      targetType: entry.targetType,
      targetId: entry.targetId,
      // The name as it is now, where the thing still exists; a deleted lane is just its id.
      targetName: structureTargetName(entry.targetType, entry.targetId),
      changes: entry.changes
    }))
  })
})

function nameOnly(person: { id: string; firstName: string; lastName: string } | null) {
  return person ? { id: person.id, firstName: person.firstName, lastName: person.lastName } : null
}

function structureTargetName(targetType: string, targetId: string | null): string | null {
  if (!targetId) return null
  switch (targetType) {
    case 'board': return findBoard(targetId)?.name ?? null
    case 'lane': return findLane(targetId)?.name ?? null
    case 'category': return findCategory(targetId)?.name ?? null
    case 'user': {
      const person = personById(targetId)
      return person ? `${person.firstName} ${person.lastName}`.trim() || null : null
    }
    default: return null
  }
}

/* ── helpers ────────────────────────────────────────────────────────────── */

/** The fields a partial update actually carried. A key present but undefined was not sent. */
function changedFields(input: Record<string, unknown>, idKey: string): string[] {
  return Object.keys(input).filter(key => key !== idKey && input[key] !== undefined).sort()
}

/** What a delete leaves for the log: the name of the thing that is no longer there to look up. */
function deletedName(result: unknown): { name?: string } {
  const name = (result as { deleted?: { name?: unknown } } | null | undefined)?.deleted?.name
  return typeof name === 'string' ? { name } : {}
}

/**
 * A lane id alone would let a board admin reach into another board's lanes, so every lane
 * operation is addressed by board *and* lane and checks that the two belong together.
 */
function laneOfBoard(laneId: string, boardId: string) {
  const lane = findLane(laneId)
  if (!lane || lane.boardId !== boardId) throw createError({ statusCode: 404, statusMessage: 'Lane not found.' })
  return lane
}

/** Categories are addressed by id, so the board to check comes from the category itself. */
function categoryBoard(categoryId: string): string {
  const category = findCategory(categoryId)
  if (!category?.boardId) throw createError({ statusCode: 404, statusMessage: 'Category not found.' })
  return category.boardId
}
