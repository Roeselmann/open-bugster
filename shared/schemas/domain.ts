import { z } from 'zod'
import { agentIcons } from '../utils/agent-icons'
import {
  activityChannels, activityKinds, boardMemberSources, boardRoles, categoryColors, integrationProviders, recurrenceFrequencies, roundOutcomes, ticketPriorities, ticketSchedules, ticketSources,
  ticketTypeColors, ticketTypeIconNames, userRoles, userStatuses, workspaceRoles
} from '../types/domain'
import type {
  AppleFeedback, Attachment, Board, BoardCredentials, BoardMember, BoardSummary, Category,
  CategorySummary, JiraIntegration, JiraIssue, Label, LabelSummary, Lane, LaneSummary, Person, SyncRun, Ticket,
  DependencyRef, SubticketRef, TimelineNode, TicketActivityEntry, TicketComment, TicketTodo, TicketType, TicketTypeIcon, TicketTypeIconRef, TicketTypeRef, TicketTypeSummary,
  Workspace, WorkspaceMember, WorkspaceSummary
} from '../types/domain'

/**
 * The published shape of everything the API returns.
 *
 * These mirror the interfaces in `../types/domain`, which stay the source of truth for the
 * app. Keeping them as schemas is what lets one definition produce the OpenAPI document and
 * the MCP tool descriptions; the assertions at the foot of this file make a drift between the
 * two a compile error rather than a surprise in somebody's generated client.
 */

/** How somebody is drawn: an uploaded portrait, or for an agent one of a fixed set of icons. */
function avatarFields() {
  return {
    avatarUrl: z.string().nullable().describe('A square portrait, versioned and fetched with the session; null when there is none.'),
    icon: z.enum(agentIcons).nullable().describe('An agent\'s chosen icon; null for people.')
  }
}

export const personSchema = z.object({
  id: z.string(),
  email: z.string().nullable().describe('null once the person has been anonymized.'),
  firstName: z.string(),
  lastName: z.string(),
  isAccount: z.boolean().describe('Whether this person can sign in.'),
  isService: z.boolean().describe('A machine principal, which holds roles but never signs in.'),
  status: z.enum(userStatuses).nullable(),
  anonymizedAt: z.string().nullable(),
  ...avatarFields()
}).describe('Somebody a ticket, comment or history entry names.')

export const labelSchema = z.object({ id: z.string(), name: z.string() })
export const labelSummarySchema = labelSchema.extend({ ticketCount: z.number().int() })

export const categorySchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.enum(categoryColors)
})
export const categorySummarySchema = categorySchema.extend({ ticketCount: z.number().int() })

export const ticketTypeIconSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lucide'), name: z.enum(ticketTypeIconNames) }),
  z.object({ kind: z.literal('image'), dataUrl: z.string().describe('A small square PNG, inline.') })
]).describe('A lucide icon by name, or an uploaded square image.')

export const ticketTypeSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  color: z.enum(ticketTypeColors).describe('Doubles as the card background on the board; `none` leaves the card as it is.'),
  icon: ticketTypeIconSchema,
  position: z.number().int(),
  createdAt: z.string()
}).describe('What kind of thing a ticket is. Owned by the workspace; a ticket may have none.')
export const ticketTypeSummarySchema = ticketTypeSchema.extend({ ticketCount: z.number().int() })

export const ticketTypeIconRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lucide'), name: z.enum(ticketTypeIconNames) }),
  z.object({ kind: z.literal('image') }).describe('The image itself is on the workspace’s type list, under this type’s id.')
])

export const ticketTypeRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.enum(ticketTypeColors),
  icon: ticketTypeIconRefSchema
}).describe('A ticket’s type, without the uploaded image: resolve the id against the workspace’s types for that.')

export const attachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(['screenshot', 'crashlog', 'file']),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  url: z.string().describe('Fetch with the same credentials; not a public link.')
})

export const subticketRefSchema = z.object({
  id: z.string(),
  ticketNumber: z.number().int(),
  title: z.string(),
  boardId: z.string(),
  boardName: z.string(),
  laneId: z.string(),
  laneName: z.string(),
  done: z.boolean().describe('Whether the subticket sits in a done or live lane of its board.'),
  archived: z.boolean()
})

export const dependencyRefSchema = z.object({
  id: z.string(),
  ticketNumber: z.number().int(),
  title: z.string(),
  boardId: z.string(),
  boardName: z.string(),
  laneName: z.string(),
  done: z.boolean().describe('Whether it sits in a done or live lane: then nothing waits on it any more.'),
  archived: z.boolean(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  strictOrderOf: z.number().int().nullable().describe('Set when the dependency comes from a strict to-do list, not by hand: the number of the ticket whose list orders the two. Not removable on its own.')
}).describe('A ticket in a finish-to-start dependency: the waiting ticket starts once this one ends.')

export const ticketRecurrenceSchema = z.object({
  frequency: z.enum(recurrenceFrequencies),
  interval: z.number().int().describe('Every so many of frequency: 2 weekly is every other week, 3 monthly a quarter.'),
  anchor: z.string().describe('The day of the first round, YYYY-MM-DD. Weekly rounds keep its weekday, monthly ones its day of the month (the last day in a shorter month).'),
  until: z.string().nullable().describe('The last day a round may fall on; null for a series without end.'),
  resetTodos: z.boolean().describe('Each new round starts with the plain to-dos unticked and the decisions open; subtickets are left alone.'),
  returnLaneId: z.string().nullable().describe('The lane the card goes back to at each new round; null leaves it where it is.')
}).describe('The rule of a recurring ticket.')

export const ticketRoundSchema = z.object({
  date: z.string().describe('The day the round was due.'),
  outcome: z.enum(roundOutcomes).describe('done (in a done or live lane, every to-do ticked, or closed by hand), missed (the next round came first) or skipped (by hand).'),
  todosDone: z.number().int(),
  todosTotal: z.number().int(),
  openTodos: z.array(z.string()).describe('The to-dos left open, by their text.'),
  closedAt: z.string(),
  closedBy: personSchema.nullable().describe('Who closed it; null when the calendar did.')
}).describe('A past round of a recurring ticket.')

export const timelineNodeSchema = z.object({
  id: z.string(),
  ticketNumber: z.number().int(),
  title: z.string(),
  boardId: z.string(),
  boardName: z.string(),
  laneName: z.string(),
  done: z.boolean().describe('Whether it sits in a done or live lane of its board.'),
  type: ticketTypeRefSchema.nullable(),
  schedule: z.enum(ticketSchedules).describe('none, milestone (one day, drawn as a diamond), lifecycle (a bar from start to due) or recurring (a diamond for each round).'),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  live: z.boolean().describe('Whether it sits in a live lane.'),
  liveFrom: z.string().nullable(),
  liveUntil: z.string().nullable(),
  recurrence: ticketRecurrenceSchema.nullable(),
  rounds: z.array(ticketRoundSchema.pick({ date: true, outcome: true })).describe('A recurring ticket\'s past rounds, newest first.'),
  waitsOn: z.array(dependencyRefSchema).describe('The tickets it waits on, wherever they are.'),
  readable: z.boolean().describe('False for a ticket on a board the caller cannot read: listed, but its own subtickets are left out.'),
  get children(): z.ZodArray<typeof timelineNodeSchema> {
    return z.array(timelineNodeSchema)
  }
}).describe('A ticket on a timeline, with the open subtickets below it.')

export const ticketDecisionSchema = z.object({
  multiple: z.boolean().describe('Several answers may be picked; otherwise exactly one.'),
  options: z.array(z.string()).describe('The answers to pick from, in order.'),
  allowOther: z.boolean().describe('Whether an answer of one\'s own may be typed in beside the options.'),
  chosen: z.array(z.number().int()).describe('Indexes into options that are picked: the result once decided.'),
  other: z.string().nullable().describe('The answer typed in, when allowOther.'),
  decidedBy: personSchema.nullable().describe('Who decided it; null while open.'),
  decidedAt: z.string().nullable()
}).describe('A question to settle by picking from a list of answers.')

export const ticketTodoSchema = z.object({
  id: z.string(),
  text: z.string().describe('For a subticket, its title.'),
  completed: z.boolean().describe('For a subticket, whether it sits in a done lane of its board; it cannot be ticked by hand.'),
  position: z.number().int(),
  subticketId: z.string().nullable().describe('Set when this to-do is a ticket of its own. Send it back with the list to keep the subticket; leaving it out unlinks it, the ticket itself stays. A to-do naming another open ticket of the workspace links that one.'),
  subticket: subticketRefSchema.nullable(),
  decision: ticketDecisionSchema.nullable().describe('Set when this to-do is a decision: text is its question, completed whether it is decided.')
})

export const ticketLinkSchema = z.object({
  id: z.string(),
  url: z.string(),
  display: z.enum(['preview', 'text']).describe('A card with a thumbnail, or the bare address.'),
  position: z.number().int(),
  preview: z.object({
    status: z.enum(['pending', 'ready', 'none']).describe('`pending` until the page has been read; `none` when it offered nothing to show.'),
    title: z.string().nullable(),
    description: z.string().nullable(),
    siteName: z.string().nullable(),
    imageUrl: z.string().nullable().describe('A thumbnail kept by the server. Fetch with the same credentials; not a public link.')
  }).describe('What the page behind the link said about itself.')
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

export const jiraIssueSchema = z.object({
  issueId: z.string(),
  issueKey: z.string(),
  projectKey: z.string().nullable(),
  issueType: z.string().nullable(),
  status: z.string().nullable(),
  statusCategory: z.string().nullable(),
  jiraPriority: z.string().nullable(),
  reporter: personSchema.nullable(),
  reporterName: z.string().nullable(),
  assigneeName: z.string().nullable(),
  url: z.string(),
  labels: z.array(z.string()),
  sourceCreatedAt: z.string(),
  sourceUpdatedAt: z.string().nullable()
}).describe('What Jira reported alongside an imported issue, frozen at import time.')

export const ticketSchema = z.object({
  id: z.string(),
  ticketNumber: z.number().int(),
  boardId: z.string(),
  laneId: z.string(),
  title: z.string(),
  description: z.string(),
  position: z.number().int(),
  priority: z.enum(ticketPriorities),
  schedule: z.enum(ticketSchedules).describe('How the ticket sits in time: `none` has no dates; `milestone` is one day, an event, kept in `dueDate`, with no start and no live window; `lifecycle` spans start to due and may have a live window, and a due date alone is a deadline; `recurring` comes round again by `recurrence`, and its `dueDate` is the round that is on now.'),
  startDate: z.string().nullable().describe('The day work starts, YYYY-MM-DD. With `dueDate` it spans the ticket on a timeline; never after it. Always null for a milestone.'),
  dueDate: z.string().nullable(),
  liveFrom: z.string().nullable().describe('The first day it is out in the world, YYYY-MM-DD: a campaign\'s start in market, an asset\'s release.'),
  liveUntil: z.string().nullable().describe('The last day it is out, YYYY-MM-DD: a campaign\'s end, an approval\'s expiry. Warns while the ticket sits in a live lane.'),
  recurrence: ticketRecurrenceSchema.nullable().describe('Set for a recurring ticket: when its rounds come. Null for every other schedule.'),
  nextRound: z.string().nullable().describe('The day the round after the current one is due; null when the ticket does not recur or its series ends with this round.'),
  rounds: z.array(ticketRoundSchema).describe('A recurring ticket\'s last twelve rounds, newest first.'),
  buildNumber: z.string().nullable(),
  link: z.string().nullable().describe('The first of `links`, kept for callers from the time a ticket had only one.'),
  links: z.array(ticketLinkSchema).describe('References elsewhere, in order; a Jira import starts with the issue.'),
  cardImageIds: z.array(z.string()).nullable().describe('The pictures picked for the ticket’s card: ids of image attachments and of links with a rendered preview. Null while nobody picked: the oldest image attachment is shown, else the first rendered link.'),
  coverAttachmentId: z.string().nullable().describe('The first picked image attachment, kept from the time the card showed only one.'),
  source: z.enum(ticketSources),
  externalId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  author: personSchema.nullable(),
  assignee: personSchema.nullable(),
  commentCount: z.number().int(),
  category: categorySchema.nullable(),
  type: ticketTypeRefSchema.nullable(),
  labels: z.array(labelSchema),
  feedback: appleFeedbackSchema.nullable(),
  jira: jiraIssueSchema.nullable(),
  attachments: z.array(attachmentSchema),
  todos: z.array(ticketTodoSchema),
  strictOrder: z.boolean().describe('The to-dos are worked top to bottom: one is ticked only once those above are done, and each subticket waits on the subticket before it.'),
  waitsOn: z.array(dependencyRefSchema).describe('The tickets it waits on: it starts once they end. Set the whole list with waitsOn on update.')
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
  isImport: z.boolean(),
  isDone: z.boolean().describe('Holds finished work; its tickets no longer warn about their due date.'),
  isLive: z.boolean().describe('Holds finished work that is running: its tickets count as done as subtickets, their due date is quiet, and their live window warns as it ends. Never also isDone.')
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
  isService: z.boolean().describe('An agent with an identity of its own rather than a person.'),
  via: z.enum(boardMemberSources).describe('board: added to this board. workspace or instance: an agent reaching it through a broader grant.'),
  addedAt: z.string(),
  ...avatarFields()
})

export const boardCredentialsSchema = z.object({
  issuerId: z.string(),
  keyId: z.string(),
  appId: z.string(),
  keyFilename: z.string().nullable(),
  keyUploadedAt: z.string().nullable(),
  complete: z.boolean()
}).describe('App Store Connect settings. The private key itself is never returned.')

export const jiraIntegrationSchema = z.object({
  siteUrl: z.string(),
  email: z.string(),
  jql: z.string(),
  tokenLabel: z.string().nullable(),
  tokenUpdatedAt: z.string().nullable(),
  complete: z.boolean()
}).describe('Jira settings. The API token itself is never returned.')

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
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
  addedAt: z.string(),
  ...avatarFields()
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
  importTypeId: z.string().nullable().describe('The ticket type every TestFlight import lands with; null leaves them untyped.'),
  dueWarningDays: z.number().int().describe('Days before its due date a card is marked orange.'),
  dueAlertDays: z.number().int().describe('Days before its due date a card is marked red; 0 is the day itself.'),
  createdAt: z.string()
})

export const boardSummarySchema = boardSchema.extend({
  lanes: z.array(laneSummarySchema),
  ticketCount: z.number().int(),
  credentials: boardCredentialsSchema,
  jira: jiraIntegrationSchema,
  members: z.array(boardMemberSchema),
  role: z.enum(boardRoles).describe('The calling principal’s own role on this board.')
})

export const syncRunSchema = z.object({
  id: z.string(),
  boardId: z.string(),
  provider: z.enum(integrationProviders),
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
  boards: z.array(z.object({ boardId: z.string(), boardName: z.string(), role: z.enum(boardRoles) })),
  ...avatarFields()
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
  TicketTypeIcon: ticketTypeIconSchema,
  TicketType: ticketTypeSchema,
  TicketTypeSummary: ticketTypeSummarySchema,
  TicketTypeIconRef: ticketTypeIconRefSchema,
  TicketTypeRef: ticketTypeRefSchema,
  Attachment: attachmentSchema,
  SubticketRef: subticketRefSchema,
  DependencyRef: dependencyRefSchema,
  TicketTodo: ticketTodoSchema,
  AppleFeedback: appleFeedbackSchema,
  Ticket: ticketSchema,
  TicketComment: ticketCommentSchema,
  TicketActivity: ticketActivitySchema,
  Lane: laneSchema,
  LaneSummary: laneSummarySchema,
  BoardMember: boardMemberSchema,
  BoardCredentials: boardCredentialsSchema,
  JiraIntegration: jiraIntegrationSchema,
  JiraIssue: jiraIssueSchema,
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
  Expect<Equal<z.infer<typeof ticketTypeIconSchema>, TicketTypeIcon>>,
  Expect<Equal<z.infer<typeof ticketTypeSchema>, TicketType>>,
  Expect<Equal<z.infer<typeof ticketTypeSummarySchema>, TicketTypeSummary>>,
  Expect<Equal<z.infer<typeof timelineNodeSchema>, TimelineNode>>,
  Expect<Equal<z.infer<typeof dependencyRefSchema>, DependencyRef>>,
  Expect<Equal<z.infer<typeof ticketTypeIconRefSchema>, TicketTypeIconRef>>,
  Expect<Equal<z.infer<typeof ticketTypeRefSchema>, TicketTypeRef>>,
  Expect<Equal<z.infer<typeof attachmentSchema>, Attachment>>,
  Expect<Equal<z.infer<typeof subticketRefSchema>, SubticketRef>>,
  Expect<Equal<z.infer<typeof ticketTodoSchema>, TicketTodo>>,
  Expect<Equal<z.infer<typeof appleFeedbackSchema>, AppleFeedback>>,
  Expect<Equal<z.infer<typeof jiraIssueSchema>, JiraIssue>>,
  Expect<Equal<z.infer<typeof jiraIntegrationSchema>, JiraIntegration>>,
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
