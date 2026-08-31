import { z } from 'zod'
import * as ops from '~~/server/operations'
import type { AnyOperation } from '~~/server/operations'
import {
  boardSummarySchema, categorySummarySchema, laneSummarySchema, labelSummarySchema,
  attachmentSchema, boardMemberSchema, personSchema, syncRunSchema, ticketActivitySchema,
  ticketCommentSchema, ticketSchema, workspaceSummarySchema
} from '~~/shared/schemas/domain'

export interface V1Route {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** `{name}` segments become path parameters and are merged into the operation's input. */
  path: string
  operation: AnyOperation
  /** Response status on success. 204 sends no body. */
  status?: 200 | 201 | 204
  /** What the operation returns, for the OpenAPI document. */
  response?: z.ZodType
  /** Applied under the request, so a public list has a page size even when nobody asked. */
  defaults?: Record<string, unknown>
  /**
   * Answers with the file itself rather than JSON. The operation still runs, and still does
   * the access check — only the response leaves the JSON convention, which is why this is a
   * flag on the route and not a second kind of operation.
   */
  download?: boolean
}

/**
 * The public contract.
 *
 * One table, dispatched from and documented from. They cannot drift because there is nothing
 * to keep in sync — the router and the OpenAPI generator read this same array.
 *
 * Deliberately absent: user administration, tokens, service identities and the App Store
 * Connect credentials. Those are instance administration, and handing them to a token surface
 * is a decision worth making on its own rather than by including them here for symmetry.
 */
export const v1Routes: readonly V1Route[] = [
  // Workspaces
  // Read-only here for now: managing workspaces stays with the UI, for the same reason user
  // administration does. A token learns which workspace each board belongs to and no more.
  { method: 'GET', path: '/workspaces', operation: ops.workspaceList, response: z.object({ workspaces: z.array(workspaceSummarySchema) }) },

  // Boards
  { method: 'GET', path: '/boards', operation: ops.boardList, response: z.object({ boards: z.array(boardSummarySchema) }) },
  { method: 'POST', path: '/boards', operation: ops.boardCreate, status: 201, response: z.object({ board: boardSummarySchema }) },
  { method: 'GET', path: '/boards/{boardId}', operation: ops.boardGet, response: z.object({ board: boardSummarySchema }) },
  { method: 'PATCH', path: '/boards/{boardId}', operation: ops.boardUpdate, response: z.object({ board: boardSummarySchema }) },
  { method: 'DELETE', path: '/boards/{boardId}', operation: ops.boardDelete, status: 204 },

  // Lanes
  { method: 'GET', path: '/boards/{boardId}/lanes', operation: ops.laneList, response: z.object({ lanes: z.array(laneSummarySchema) }) },
  { method: 'POST', path: '/boards/{boardId}/lanes', operation: ops.laneCreate, status: 201, response: z.object({ lanes: z.array(laneSummarySchema) }) },
  { method: 'PATCH', path: '/boards/{boardId}/lanes/{laneId}', operation: ops.laneUpdate, response: z.object({ lanes: z.array(laneSummarySchema) }) },
  { method: 'DELETE', path: '/boards/{boardId}/lanes/{laneId}', operation: ops.laneDelete, response: z.object({ lanes: z.array(laneSummarySchema) }) },
  { method: 'PATCH', path: '/boards/{boardId}/lane-order', operation: ops.laneReorder, response: z.object({ lanes: z.array(laneSummarySchema) }) },

  // Members
  { method: 'GET', path: '/boards/{boardId}/members', operation: ops.memberList, response: z.object({ members: z.array(boardMemberSchema) }) },
  { method: 'GET', path: '/boards/{boardId}/member-candidates', operation: ops.memberCandidates, response: z.object({ candidates: z.array(personSchema.pick({ id: true, email: true, firstName: true, lastName: true, status: true })) }) },
  { method: 'PUT', path: '/boards/{boardId}/members/{userId}', operation: ops.memberSet, response: z.object({ member: boardMemberSchema, board: boardSummarySchema.nullable() }) },
  { method: 'DELETE', path: '/boards/{boardId}/members/{userId}', operation: ops.memberRemove, response: z.object({ board: boardSummarySchema.nullable() }) },

  // Tickets
  {
    method: 'GET', path: '/boards/{boardId}/tickets', operation: ops.ticketList,
    // A board with thousands of tickets must not be one response just because nobody said so.
    // The UI calls the operation directly and is unaffected by this.
    defaults: { limit: 100 },
    response: z.object({ tickets: z.array(ticketSchema), nextCursor: z.number().int().nullable().optional().describe('Pass as `cursor` for the next page; null on the last one.') })
  },
  { method: 'POST', path: '/tickets', operation: ops.ticketCreate, status: 201, response: z.object({ ticket: ticketSchema }) },
  { method: 'GET', path: '/tickets/{ticketId}', operation: ops.ticketGet, response: z.object({ ticket: ticketSchema }) },
  // Numbers are unique instance-wide, so this needs no board. It is how a commit message or a
  // CI job refers to a ticket, which is the only identifier those ever have to hand.
  { method: 'GET', path: '/tickets/by-number/{ticketNumber}', operation: ops.ticketGetByNumber, response: z.object({ ticket: ticketSchema }) },
  { method: 'PATCH', path: '/tickets/{ticketId}', operation: ops.ticketUpdate, response: z.object({ ticket: ticketSchema }) },
  { method: 'POST', path: '/tickets/{ticketId}/move', operation: ops.ticketMove, response: z.object({ ticket: ticketSchema }) },
  { method: 'POST', path: '/tickets/{ticketId}/archive', operation: ops.ticketArchive, response: z.object({ ticket: ticketSchema }) },
  { method: 'POST', path: '/tickets/{ticketId}/restore', operation: ops.ticketRestore, response: z.object({ ticket: ticketSchema }) },
  { method: 'GET', path: '/tickets/{ticketId}/activity', operation: ops.ticketActivity, response: z.object({ activity: z.array(ticketActivitySchema) }) },

  // Attachments
  // The download is what an agent following a ticket's `url` was always missing — that path
  // is the UI's own API and takes a cookie, so a token could list attachments and fetch
  // none of them. The upload carries the file as base64 in the body; see `attachment.add`.
  { method: 'GET', path: '/attachments/{attachmentId}', operation: ops.attachmentGet, download: true },
  {
    method: 'POST', path: '/tickets/{ticketId}/attachments', operation: ops.attachmentAdd, status: 201,
    response: z.object({ attachment: attachmentSchema })
  },

  // Comments
  { method: 'GET', path: '/tickets/{ticketId}/comments', operation: ops.commentList, response: z.object({ comments: z.array(ticketCommentSchema) }) },
  { method: 'POST', path: '/tickets/{ticketId}/comments', operation: ops.commentAdd, status: 201, response: z.object({ comment: ticketCommentSchema }) },
  { method: 'PATCH', path: '/comments/{commentId}', operation: ops.commentUpdate, response: z.object({ comment: ticketCommentSchema }) },
  { method: 'DELETE', path: '/comments/{commentId}', operation: ops.commentRemove, status: 204 },

  // Categories and labels
  { method: 'GET', path: '/boards/{boardId}/categories', operation: ops.categoryList, response: z.object({ categories: z.array(categorySummarySchema) }) },
  { method: 'PATCH', path: '/categories/{categoryId}', operation: ops.categoryUpdate, response: z.object({ category: categorySummarySchema.partial({ ticketCount: true }) }) },
  { method: 'DELETE', path: '/categories/{categoryId}', operation: ops.categoryDelete, status: 204 },
  { method: 'GET', path: '/boards/{boardId}/labels', operation: ops.labelList, response: z.object({ labels: z.array(labelSummarySchema) }) },

  // TestFlight import
  { method: 'GET', path: '/boards/{boardId}/import', operation: ops.importStatus, response: z.object({ run: syncRunSchema.nullable() }) },
  { method: 'POST', path: '/boards/{boardId}/import', operation: ops.importRun, response: z.object({ run: syncRunSchema }) }
]

/** `/boards/{boardId}/lanes` → a matcher and the parameter names it fills in. */
export interface CompiledRoute extends V1Route {
  pattern: RegExp
  params: string[]
}

export const compiledRoutes: readonly CompiledRoute[] = v1Routes.map((route) => {
  const params: string[] = []
  const pattern = route.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    params.push(name)
    return '([^/]+)'
  })
  return { ...route, params, pattern: new RegExp(`^${pattern}$`) }
})

export function matchRoute(method: string, path: string): { route: CompiledRoute; params: Record<string, string> } | null {
  let pathExists = false
  for (const route of compiledRoutes) {
    const found = route.pattern.exec(path)
    if (!found) continue
    pathExists = true
    if (route.method !== method) continue
    const params: Record<string, string> = {}
    route.params.forEach((name, index) => { params[name] = decodeURIComponent(found[index + 1]!) })
    return { route, params }
  }
  // A path that exists under another method is a 405, which is worth distinguishing from a
  // 404 — it tells a caller their URL is right and their verb is not.
  if (pathExists) throw Object.assign(new Error('method-not-allowed'), { statusCode: 405 })
  return null
}
