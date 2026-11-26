import { z } from 'zod'
import * as ops from '~~/server/operations'
import type { AnyOperation } from '~~/server/operations'
import {
  boardSummarySchema, categorySummarySchema, laneSummarySchema, labelSummarySchema,
  attachmentSchema, boardMemberSchema, categorySchema, laneSchema, personSchema, syncRunSchema, ticketActivitySchema,
  dependencyRefSchema, subticketRefSchema, ticketCommentSchema, ticketSchema, ticketTypeSchema, ticketTypeSummarySchema, timelineNodeSchema, workspaceSummarySchema
} from '~~/shared/schemas/domain'

const shiftDatesSchema = z.object({ from: z.string().nullable(), to: z.string().nullable() })
const shiftResultSchema = z.object({
  days: z.number().int(),
  applied: z.boolean().describe('False for a dry run: nothing was written.'),
  moves: z.array(z.object({
    ticketId: z.string(), ticketNumber: z.number().int(), title: z.string(), boardName: z.string(),
    startDate: shiftDatesSchema, dueDate: shiftDatesSchema
  })).describe('The ticket and everything waiting on it that has dates, in the order the push reached them.'),
  skipped: z.array(z.object({
    ticketId: z.string(), ticketNumber: z.number().int(), title: z.string().nullable(),
    reason: z.enum(['finished', 'no_access'])
  })).describe('Tickets the push stopped at: finished work, or a ticket the caller may not edit.')
})

const labelChangeSchema = z.object({
  ticketsTouched: z.number().int().describe('How many tickets carried the label before.'),
  labels: z.array(labelSummarySchema).describe('The board\'s labels afterwards.')
})

const structureEntrySchema = z.object({
  operation: z.string().describe('The operation, e.g. `lane.update`.'),
  at: z.string(),
  principal: z.object({ id: z.string(), firstName: z.string(), lastName: z.string() }).nullable().describe('Who did it; null once their account is gone.'),
  agentId: z.string().nullable().describe('The agent label of the token it came through, if any.'),
  targetType: z.string(),
  targetId: z.string().nullable(),
  targetName: z.string().nullable().describe('The target\'s name as it is now; null once it is gone.'),
  changes: z.record(z.string(), z.unknown()).describe('The fields the operation records about itself — ids and names of board things, never secrets.')
})

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
 *
 * A board's structure — lanes, members, categories, labels, and its workspace's ticket types —
 * is here in full, at parity with the MCP structure tools: an agent with an account of its own
 * organises its boards, and a script should be able to do what that agent can.
 */
export const v1Routes: readonly V1Route[] = [
  // Workspaces
  // Read-only here for now: managing workspaces stays with the UI, for the same reason user
  // administration does. A token learns which workspace each board belongs to and no more.
  { method: 'GET', path: '/workspaces', operation: ops.workspaceList, response: z.object({ workspaces: z.array(workspaceSummarySchema) }) },
  // The vocabulary a ticket's `typeId` draws from, managed by the workspace's administrators.
  // The workspace itself stays with the UI; its types are board structure, and are here.
  { method: 'GET', path: '/workspaces/{workspaceId}/ticket-types', operation: ops.ticketTypeList, response: z.object({ types: z.array(ticketTypeSummarySchema) }) },
  { method: 'POST', path: '/workspaces/{workspaceId}/ticket-types', operation: ops.ticketTypeCreate, status: 201, response: z.object({ type: ticketTypeSchema }) },
  { method: 'PATCH', path: '/workspaces/{workspaceId}/ticket-type-order', operation: ops.ticketTypeReorder, response: z.object({ types: z.array(ticketTypeSummarySchema) }) },
  { method: 'PATCH', path: '/ticket-types/{typeId}', operation: ops.ticketTypeUpdate, response: z.object({ type: ticketTypeSchema }) },
  { method: 'DELETE', path: '/ticket-types/{typeId}', operation: ops.ticketTypeDelete, status: 204 },

  // Boards
  { method: 'GET', path: '/boards', operation: ops.boardList, response: z.object({ boards: z.array(boardSummarySchema) }) },
  { method: 'POST', path: '/boards', operation: ops.boardCreate, status: 201, response: z.object({ board: boardSummarySchema }) },
  { method: 'GET', path: '/boards/{boardId}', operation: ops.boardGet, response: z.object({ board: boardSummarySchema }) },
  { method: 'PATCH', path: '/boards/{boardId}', operation: ops.boardUpdate, response: z.object({ board: boardSummarySchema }) },
  // `?onlyIfEmpty=true` refuses with 409 while the board holds any ticket, archived ones too.
  { method: 'DELETE', path: '/boards/{boardId}', operation: ops.boardDelete, status: 204 },
  // What was done to the board's lanes, members, categories and labels — readable by every
  // member, unlike the full audit log, which stays off this surface.
  { method: 'GET', path: '/boards/{boardId}/structure-log', operation: ops.boardStructureList, response: z.object({ entries: z.array(structureEntrySchema) }) },

  // Lanes
  { method: 'GET', path: '/boards/{boardId}/timeline', operation: ops.boardTimelineGet, response: z.object({ timeline: z.array(timelineNodeSchema).describe('The board\'s tickets that lead a tree, in lane order, each with its subtickets below; only trees with a date somewhere.') }) },
  { method: 'GET', path: '/boards/{boardId}/lanes', operation: ops.laneList, response: z.object({ lanes: z.array(laneSummarySchema) }) },
  { method: 'POST', path: '/boards/{boardId}/lanes', operation: ops.laneCreate, status: 201, response: z.object({ lane: laneSchema.describe('The lane just added, at the right end.'), lanes: z.array(laneSummarySchema) }) },
  { method: 'PATCH', path: '/boards/{boardId}/lanes/{laneId}', operation: ops.laneUpdate, response: z.object({ lanes: z.array(laneSummarySchema) }) },
  { method: 'DELETE', path: '/boards/{boardId}/lanes/{laneId}', operation: ops.laneDelete, response: z.object({ lanes: z.array(laneSummarySchema), deleted: z.object({ id: z.string(), name: z.string() }).describe('The lane that was removed.') }) },
  { method: 'PATCH', path: '/boards/{boardId}/lane-order', operation: ops.laneReorder, response: z.object({ lanes: z.array(laneSummarySchema) }) },

  // Members
  { method: 'GET', path: '/boards/{boardId}/members', operation: ops.memberList, response: z.object({ members: z.array(boardMemberSchema) }) },
  { method: 'GET', path: '/boards/{boardId}/member-candidates', operation: ops.memberCandidates, response: z.object({ candidates: z.array(personSchema.pick({ id: true, email: true, firstName: true, lastName: true, status: true, isService: true })) }) },
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
  { method: 'POST', path: '/tickets/{ticketId}/transfer', operation: ops.ticketTransfer, response: z.object({ ticket: ticketSchema, assigneeCleared: z.boolean().describe('True when the assignee was no member of the destination board and was dropped.') }) },
  { method: 'GET', path: '/tickets/{ticketId}/dependents', operation: ops.ticketDependentsList, response: z.object({ dependents: z.array(dependencyRefSchema).describe('The tickets that wait on this one, on boards the caller can read.') }) },
  { method: 'POST', path: '/tickets/{ticketId}/shift', operation: ops.ticketShift, response: shiftResultSchema },
  { method: 'POST', path: '/tickets/{ticketId}/round', operation: ops.ticketRoundClose, response: z.object({
    ticket: ticketSchema.describe('The ticket as its new round starts.'),
    round: z.object({
      date: z.string().describe('The day the round that closed was due.'),
      outcome: z.enum(['done', 'skipped']),
      next: z.string().nullable().describe('The day the new round is due; null when the series ended with this one.')
    })
  }) },
  { method: 'DELETE', path: '/tickets/{ticketId}/round', operation: ops.ticketRoundReopen, response: z.object({
    ticket: ticketSchema.describe('The ticket with the round open again: its due date, to-dos and lane as they were.'),
    round: z.object({
      date: z.string().describe('The day the reopened round is due.'),
      outcome: z.enum(['done', 'missed', 'skipped']).describe('How it had closed.')
    })
  }) },
  { method: 'GET', path: '/tickets/{ticketId}/parents', operation: ops.ticketParentsList, response: z.object({ parents: z.array(subticketRefSchema).describe('The tickets that hold this one as a subticket, on boards the caller can read.') }) },
  { method: 'GET', path: '/tickets/{ticketId}/timeline', operation: ops.ticketTimelineGet, response: z.object({ timeline: timelineNodeSchema }) },
  { method: 'GET', path: '/tickets/{ticketId}/subticket-candidates', operation: ops.ticketSubticketCandidates, response: z.object({ candidates: z.array(subticketRefSchema).describe('Open tickets of the workspace that could be linked: send one back in the to-do list with its id as `subticketId`. With `for=dependency`, the tickets this one could wait on instead: send ids back as `waitsOn`.') }) },
  { method: 'POST', path: '/tickets/{ticketId}/subtickets', operation: ops.ticketSubticketCreate, status: 201, response: z.object({ ticket: ticketSchema.describe('The parent, with the new subticket at the end of its to-do list.'), subticket: ticketSchema }) },
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
  {
    method: 'POST', path: '/tickets/{ticketId}/attachments/from-url', operation: ops.attachmentAddFromUrl, status: 201,
    response: z.object({ attachment: attachmentSchema })
  },
  // For a file on the caller's own disk, sent without the token: see `attachment.uploadUrl`.
  {
    method: 'POST', path: '/tickets/{ticketId}/attachments/upload-url', operation: ops.attachmentUploadUrl, status: 201,
    response: z.object({
      upload: z.object({
        path: z.string().describe('POST one file here as the multipart field `field`, with no Authorization header.'),
        method: z.literal('POST'),
        field: z.string(),
        expiresAt: z.string(),
        expiresInMinutes: z.number().int()
      })
    })
  },

  // Comments
  { method: 'GET', path: '/tickets/{ticketId}/comments', operation: ops.commentList, response: z.object({ comments: z.array(ticketCommentSchema) }) },
  { method: 'POST', path: '/tickets/{ticketId}/comments', operation: ops.commentAdd, status: 201, response: z.object({ comment: ticketCommentSchema }) },
  { method: 'PATCH', path: '/comments/{commentId}', operation: ops.commentUpdate, response: z.object({ comment: ticketCommentSchema }) },
  { method: 'DELETE', path: '/comments/{commentId}', operation: ops.commentRemove, status: 204 },

  // Categories and labels
  { method: 'GET', path: '/boards/{boardId}/categories', operation: ops.categoryList, response: z.object({ categories: z.array(categorySummarySchema) }) },
  { method: 'POST', path: '/boards/{boardId}/categories', operation: ops.categoryCreate, status: 201, response: z.object({ category: categorySchema }) },
  { method: 'PATCH', path: '/categories/{categoryId}', operation: ops.categoryUpdate, response: z.object({ category: categorySummarySchema.partial({ ticketCount: true }) }) },
  { method: 'DELETE', path: '/categories/{categoryId}', operation: ops.categoryDelete, status: 204 },
  { method: 'GET', path: '/boards/{boardId}/labels', operation: ops.labelList, response: z.object({ labels: z.array(labelSummarySchema) }) },
  // A label is known by its name, so the name is the path segment — percent-encode it.
  { method: 'PATCH', path: '/boards/{boardId}/labels/{name}', operation: ops.labelRename, response: labelChangeSchema.extend({
    label: z.object({ id: z.string(), name: z.string() }).nullable().describe('The label that carries the tickets now.'),
    merged: z.boolean().describe('True when newName already belonged to another label, which now holds the tickets of both.')
  }) },
  { method: 'DELETE', path: '/boards/{boardId}/labels/{name}', operation: ops.labelDelete, response: labelChangeSchema },

  // Imports — TestFlight or Jira, chosen by `provider`
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
