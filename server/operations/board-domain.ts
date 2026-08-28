import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createError } from 'h3'
import { z } from 'zod'
import { AppleApiError, syncTestFlight } from '../utils/app-store-connect'
import { getServerConfig } from '../utils/config'
import { SecretBoxError } from '../utils/secret-box'
import { boardViewer } from '../utils/access'
import {
  CategoryNameTakenError, LaneDeleteError, boardMembers, boardRoleFor, countBoardAdmins, countBoards,
  createBoard, createComment, createLane, deleteBoard, deleteCategory, deleteComment, deleteLane, findBoardSummary,
  boardSyncCredentials, findCategory, findLane, importLaneFor, latestSyncRun, listBoards, listCategories, listComments, listLabels, listLanes,
  listUsers, removeBoardMember, reorderLanes, setBoardMember, updateBoard, updateCategory, updateComment, updateLane
} from '../utils/db'
import {
  boardCreateSchema, boardMemberSchema, boardUpdateSchema, categoryUpdateSchema, commentSaveSchema,
  importRequestSchema, laneCreateSchema, laneOrderSchema, laneUpdateSchema
} from '../utils/validation'
import { createdId, defineOperation } from './types'
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
  run: ctx => ({ boards: listBoards(boardViewer(ctx.account)) })
})

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
  input: boardCreateSchema,
  requires: { scope: 'instance' },
  audit: { targetType: 'board', targetId: createdId('board'), changes: ['name'] },
  run: (ctx, input) => ({ board: createBoard(input.name, ctx.account.id) })
})

export const boardUpdate = defineOperation({
  name: 'board.update',
  summary: 'Change a board’s name, description or sync settings',
  input: boardUpdateSchema.extend({ boardId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  // The App Store Connect ids are configuration, not secrets — the private key never passes
  // through this operation at all, and could not be logged even by mistake.
  audit: { targetType: 'board', targetId: input => input.boardId, changes: input => ({ fields: Object.keys(input).filter(key => key !== 'boardId').sort() }) },
  run: (ctx, input) => {
    const { boardId, ...fields } = input
    return { board: orNotFound(updateBoard(boardId, fields, boardViewer(ctx.account)), 'Board') }
  }
})

export const boardDelete = defineOperation({
  name: 'board.delete',
  summary: 'Delete a board and everything on it',
  input: z.object({ boardId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'board', targetId: input => input.boardId },
  run: async (_ctx, input) => {
    if (countBoards() <= 1) throw createError({ statusCode: 409, statusMessage: 'The last board cannot be deleted.' })
    const { ticketIds } = orNotFound(deleteBoard(input.boardId), 'Board')
    // The attachments belong to the tickets that just went, so clearing them belongs here
    // rather than in a route — every surface that can delete a board owes the same cleanup.
    // The rows are gone either way; a leftover folder beats failing the request.
    const root = resolve(getServerConfig().attachmentsPath)
    await Promise.all(ticketIds.map(ticketId => rm(join(root, ticketId), { recursive: true, force: true }).catch(() => undefined)))
    return null
  }
})

export const importRun = defineOperation({
  name: 'import.run',
  summary: 'Pull the newest TestFlight feedback onto a board',
  input: importRequestSchema,
  // A sync spends the board's App Store Connect key and writes tickets into the import lane
  // under the board's own name, so it belongs to whoever owns those credentials.
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'board', targetId: input => input.boardId },
  run: async (_ctx, input) => {
    const importLane = importLaneFor(input.boardId)
    if (!importLane) throw createError({ statusCode: 409, statusMessage: 'This board has no import lane.' })
    const credentials = boardSyncCredentials(input.boardId)!
    try {
      return {
        run: await syncTestFlight({
          boardId: input.boardId,
          laneId: importLane.id,
          issuerId: credentials.issuerId,
          keyId: credentials.keyId,
          appId: credentials.appId,
          privateKeyPem: credentials.privateKeyPem,
          syncLimit: credentials.syncLimit,
          autoAuthor: credentials.autoAuthor,
          attachmentsPath: getServerConfig().attachmentsPath
        })
      }
    } catch (error) {
      if (error instanceof AppleApiError) throw createError({ statusCode: error.statusCode, statusMessage: error.message })
      if (error instanceof SecretBoxError) throw createError({ statusCode: 500, statusMessage: error.message })
      throw createError({ statusCode: 500, statusMessage: error instanceof Error ? error.message : 'TestFlight sync failed.' })
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
  audit: { targetType: 'lane', changes: ['name'] },
  run: (_ctx, input) => {
    orNotFound(createLane(input.boardId, input.name), 'Board')
    return { lanes: listLanes(input.boardId) }
  }
})

export const laneUpdate = defineOperation({
  name: 'lane.update',
  summary: 'Rename a lane',
  input: laneUpdateSchema.extend({ boardId: id, laneId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'lane', targetId: input => input.laneId, changes: ['name'] },
  run: (_ctx, input) => {
    laneOfBoard(input.laneId, input.boardId)
    updateLane(input.laneId, { name: input.name })
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
    z.object({ boardId: id, laneId: id, mode: z.literal('archive') })
  ]),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'lane', targetId: input => input.laneId, changes: ['mode'] },
  run: (_ctx, input) => {
    laneOfBoard(input.laneId, input.boardId)
    try {
      return { lanes: deleteLane(input.laneId, input.mode, input.mode === 'move' ? input.targetLaneId : undefined) }
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
      candidates: listUsers()
        // An anonymized account is a tombstone: it keeps its history and is offered to nobody.
        .filter(user => !existing.has(user.id) && !user.anonymizedAt)
        .map(user => ({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, status: user.status }))
    }
  }
})

export const memberSet = defineOperation({
  name: 'member.set',
  summary: 'Add somebody to a board, or change the role they hold',
  input: boardMemberSchema.extend({ boardId: id, userId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: { targetType: 'user', targetId: input => input.userId, changes: ['role'] },
  run: (ctx, input) => {
    const member = setBoardMember(input.boardId, input.userId, input.role)
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
  audit: { targetType: 'category', targetId: input => input.categoryId },
  run: (_ctx, input) => {
    if (!deleteCategory(input.categoryId)) throw createError({ statusCode: 404, statusMessage: 'Category not found.' })
    return null
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

/* ── import ─────────────────────────────────────────────────────────────── */

export const importStatus = defineOperation({
  name: 'import.status',
  summary: 'Read the most recent TestFlight sync for a board',
  input: z.object({ boardId: id }),
  requires: { scope: 'board', role: 'viewer', boardId: boardOf },
  audit: false,
  run: (_ctx, input) => ({ run: latestSyncRun(input.boardId) })
})

/* ── helpers ────────────────────────────────────────────────────────────── */

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
