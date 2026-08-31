import { z } from 'zod'
import {
  activityChannels, activityKinds, boardRoles, categoryColors, ticketPriorities, ticketSources,
  userRoles, userStatuses, workspaceRoles
} from '../types/domain'
import type {
  AppleFeedback, Attachment, Board, BoardCredentials, BoardMember, BoardSummary, Category,
  CategorySummary, Label, LabelSummary, Lane, LaneSummary, Person, SyncRun, Ticket,
  TicketActivityEntry, TicketComment, TicketTodo, Workspace, WorkspaceMember, WorkspaceSummary
} from '../types/domain'

/**
 * The published shape of everything the API returns.
 *
 * These mirror the interfaces in `../types/domain`, which stay the source of truth for the
 * app. Keeping them as schemas is what lets one definition produce the OpenAPI document and
 * the MCP tool descriptions; the assertions at the foot of this file make a drift between the
 * two a compile error rather than a surprise in somebody's generated client.
 */

export const personSchema = z.object({
  id: z.string(),
  email: z.string().nullable().describe('null once the person has been anonymized.'),
  firstName: z.string(),
  lastName: z.string(),
  isAccount: z.boolean().describe('Whether this person can sign in.'),
  isService: z.boolean().describe('A machine principal, which holds roles but never signs in.'),
  status: z.enum(userStatuses).nullable(),
  anonymizedAt: z.string().nullable()
}).describe('Somebody a ticket, comment or history entry names.')

export const labelSchema = z.object({ id: z.string(), name: z.string() })
export const labelSummarySchema = labelSchema.extend({ ticketCount: z.number().int() })

export const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.enum(categoryColors)
})
export const categorySummarySchema = categorySchema.extend({ ticketCount: z.number().int() })

export const attachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(['screenshot', 'crashlog', 'file']),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  url: z.string().describe('Fetch with the same credentials; not a public link.')
})

export const ticketTodoSchema = z.object({
  id: z.string(),
  text: z.string(),
  completed: z.boolean(),
  position: z.number().int()
})

export const appleFeedbackSchema = z.object({
  feedbackType: z.enum(['screenshot', 'crash']),
  comment: z.string().nullable(),
  tester: personSchema.nullable(),
  deviceModel: z.string().nullable(),
  osVersion: z.string().nullable(),
  locale: z.string().nullable(),
  buildId: z.string().nullable(),
  buildVersion: z.string().nullable(),
  buildBundleId: z.string().nullable(),
  sourceCreatedAt: z.string()
}).describe('What TestFlight reported alongside an imported ticket.')

export const ticketSchema = z.object({
  id: z.string(),
  ticketNumber: z.number().int(),
  boardId: z.string(),
  laneId: z.string(),
  title: z.string(),
  description: z.string(),
  position: z.number().int(),
  priority: z.enum(ticketPriorities),
  dueDate: z.string().nullable(),
  buildNumber: z.string().nullable(),
  source: z.enum(ticketSources),
  externalId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  author: personSchema.nullable(),
  assignee: personSchema.nullable(),
  commentCount: z.number().int(),
  category: categorySchema.nullable(),
  labels: z.array(labelSchema),
  feedback: appleFeedbackSchema.nullable(),
  attachments: z.array(attachmentSchema),
  todos: z.array(ticketTodoSchema)
})

export const ticketCommentSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  author: personSchema.nullable(),
  authorId: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
})

export const ticketActivitySchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  actor: personSchema.nullable().describe('Who answers for the change.'),
  agentId: z.string().nullable().describe('What performed it, when that was not a person directly.'),
  channel: z.enum(activityChannels),
  kind: z.enum(activityKinds),
  payload: z.record(z.string(), z.string().nullable()),
  payloadPeople: z.record(z.string(), personSchema.nullable()),
  createdAt: z.string()
})

export const laneSchema = z.object({
  id: z.string(),
  boardId: z.string(),
  name: z.string(),
  position: z.number().int(),
  isImport: z.boolean()
})
export const laneSummarySchema = laneSchema.extend({
  ticketCount: z.number().int(),
  archivedCount: z.number().int()
})

export const boardMemberSchema = z.object({
  userId: z.string(),
  email: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string(),
  status: z.enum(userStatuses),
  role: z.enum(boardRoles),
  mayAutomate: z.boolean(),
  addedAt: z.string()
})

export const boardCredentialsSchema = z.object({
  issuerId: z.string(),
  keyId: z.string(),
  appId: z.string(),
  keyFilename: z.string().nullable(),
  keyUploadedAt: z.string().nullable(),
  complete: z.boolean()
}).describe('App Store Connect settings. The private key itself is never returned.')

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number().int(),
  createdAt: z.string()
}).describe('The level above boards. Groups them; grants no board access by itself.')

export const workspaceMemberSchema = z.object({
  userId: z.string(),
  email: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string(),
  status: z.enum(userStatuses),
  role: z.enum(workspaceRoles),
  addedAt: z.string()
})

export const workspaceSummarySchema = workspaceSchema.extend({
  members: z.array(workspaceMemberSchema),
  boardCount: z.number().int().describe('Every board in the workspace, whether or not the caller can open it.'),
  role: z.enum(workspaceRoles).nullable().describe('The calling principal’s own role; null when visibility comes from a board alone.')
})

export const boardSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string(),
  position: z.number().int(),
  syncLimit: z.number().int(),
  autoAuthor: z.boolean(),
  createdAt: z.string()
})

export const boardSummarySchema = boardSchema.extend({
  lanes: z.array(laneSummarySchema),
  ticketCount: z.number().int(),
  credentials: boardCredentialsSchema,
  members: z.array(boardMemberSchema),
  role: z.enum(boardRoles).describe('The calling principal’s own role on this board.')
})

export const syncRunSchema = z.object({
  id: z.string(),
  boardId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(['running', 'success', 'partial', 'failed']),
  importedCount: z.number().int(),
  skippedCount: z.number().int(),
  failedCount: z.number().int(),
  errorMessage: z.string().nullable()
})

export const userAccountSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  firstName: z.string(),
  lastName: z.string(),
  role: z.enum(userRoles),
  status: z.enum(userStatuses),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  anonymizedAt: z.string().nullable(),
  inviteExpiresAt: z.string().nullable(),
  boards: z.array(z.object({ boardId: z.string(), boardName: z.string(), role: z.enum(boardRoles) }))
})

/**
 * Names every schema for the OpenAPI document.
 *
 * Without this, `z.toJSONSchema` lifts shared subschemas into `__schema0`, `__schema1` and so
 * on — which round-trips fine but produces a generated client full of anonymous types. The id
 * here becomes the name in `components.schemas`, so it is part of the published contract:
 * renaming one is a breaking change for anybody who generated against it.
 */
// Typed as a plain record rather than `as const`: the union of nineteen distinct zod schema
// types is large enough that `Object.entries` over it exceeds what TypeScript will represent.
const named: Record<string, z.ZodType> = {
  Person: personSchema,
  Label: labelSchema,
  LabelSummary: labelSummarySchema,
  Category: categorySchema,
  CategorySummary: categorySummarySchema,
  Attachment: attachmentSchema,
  TicketTodo: ticketTodoSchema,
  AppleFeedback: appleFeedbackSchema,
  Ticket: ticketSchema,
  TicketComment: ticketCommentSchema,
  TicketActivity: ticketActivitySchema,
  Lane: laneSchema,
  LaneSummary: laneSummarySchema,
  BoardMember: boardMemberSchema,
  BoardCredentials: boardCredentialsSchema,
  Board: boardSchema,
  BoardSummary: boardSummarySchema,
  Workspace: workspaceSchema,
  WorkspaceMember: workspaceMemberSchema,
  WorkspaceSummary: workspaceSummarySchema,
  SyncRun: syncRunSchema,
  UserAccount: userAccountSchema
}

for (const [id, schema] of Object.entries(named)) schema.register(z.globalRegistry, { id })

/**
 * The drift guard.
 *
 * `Equal` is the invariant comparison — a field on one side and not the other fails it — and
 * `Expect` turns that into a constraint violation. Adding a field to an interface without its
 * schema, or the reverse, stops compiling here rather than silently producing an OpenAPI
 * document that lies about the response.
 *
 * These are types only; nothing survives to runtime. An earlier version used `as` casts, which
 * compiled happily against a deliberately broken schema and checked nothing at all.
 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

export type SchemasMatchDomain = [
  Expect<Equal<z.infer<typeof personSchema>, Person>>,
  Expect<Equal<z.infer<typeof labelSchema>, Label>>,
  Expect<Equal<z.infer<typeof labelSummarySchema>, LabelSummary>>,
  Expect<Equal<z.infer<typeof categorySchema>, Category>>,
  Expect<Equal<z.infer<typeof categorySummarySchema>, CategorySummary>>,
  Expect<Equal<z.infer<typeof attachmentSchema>, Attachment>>,
  Expect<Equal<z.infer<typeof ticketTodoSchema>, TicketTodo>>,
  Expect<Equal<z.infer<typeof appleFeedbackSchema>, AppleFeedback>>,
  Expect<Equal<z.infer<typeof ticketSchema>, Ticket>>,
  Expect<Equal<z.infer<typeof ticketCommentSchema>, TicketComment>>,
  Expect<Equal<z.infer<typeof ticketActivitySchema>, TicketActivityEntry>>,
  Expect<Equal<z.infer<typeof laneSchema>, Lane>>,
  Expect<Equal<z.infer<typeof laneSummarySchema>, LaneSummary>>,
  Expect<Equal<z.infer<typeof boardMemberSchema>, BoardMember>>,
  Expect<Equal<z.infer<typeof boardCredentialsSchema>, BoardCredentials>>,
  Expect<Equal<z.infer<typeof boardSchema>, Board>>,
  Expect<Equal<z.infer<typeof boardSummarySchema>, BoardSummary>>,
  Expect<Equal<z.infer<typeof workspaceSchema>, Workspace>>,
  Expect<Equal<z.infer<typeof workspaceMemberSchema>, WorkspaceMember>>,
  Expect<Equal<z.infer<typeof workspaceSummarySchema>, WorkspaceSummary>>,
  Expect<Equal<z.infer<typeof syncRunSchema>, SyncRun>>
]
