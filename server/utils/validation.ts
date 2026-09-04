import { createError } from 'h3'
import { z } from 'zod'
import { boardRoles, categoryColors, integrationProviders, ticketTypeColors, ticketTypeIconNames, userRoles, userStatuses, workspaceRoles } from '../../shared/types/domain'
import { TICKET_TYPE_ICON_DATA_URL_MAX } from '../../shared/utils/constants'
import { isJiraSiteUrl, normalizeSiteUrl } from './jira-policy'

/** Email is the identity key, so it is normalised the same way everywhere it is accepted. */
const emailSchema = z.email('A valid email address is required.').trim().toLowerCase().max(160)
const passwordSchema = z.string().min(12, 'Use at least 12 characters.').max(512)

const labelSchema = z.string().trim().min(1).max(30)
const todoSchema = z.object({
  text: z.string().trim().min(1).max(500),
  // Defaulted for API and MCP callers, for whom "a new to-do" is the common case; the UI
  // always sends the flag explicitly.
  completed: z.boolean().default(false)
})

const idSchema = z.string().trim().min(1).max(64)

const ticketShape = {
  title: z.string().trim().min(1, 'Title is required.').max(160),
  description: z.string().max(10000),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  assigneeId: idSchema.nullable(),
  dueDate: z.iso.date().nullable(),
  buildNumber: z.string().trim().max(100).nullable(),
  /** A web address or nothing; an empty string reads as nothing. */
  link: z.string().trim().max(2000).transform(value => value || null).nullable()
    .refine(value => value === null || /^https?:\/\/\S+$/i.test(value), 'A link has to start with http:// or https://.'),
  labels: z.array(labelSchema).max(12),
  categoryName: z.string().trim().max(30).nullable(),
  /** A type of the board's workspace; null leaves the ticket untyped. */
  typeId: idSchema.nullable(),
  todos: z.array(todoSchema).max(100)
}

export const ticketCreateSchema = z.object({
  ...ticketShape,
  boardId: idSchema,
  laneId: idSchema.optional(),
  description: ticketShape.description.default(''),
  priority: ticketShape.priority.default('medium'),
  assigneeId: ticketShape.assigneeId.optional(),
  dueDate: ticketShape.dueDate.optional(),
  buildNumber: ticketShape.buildNumber.optional(),
  link: ticketShape.link.optional(),
  labels: ticketShape.labels.default([]),
  categoryName: ticketShape.categoryName.optional(),
  typeId: ticketShape.typeId.optional(),
  todos: ticketShape.todos.default([]),
  /** Where in its lane the ticket lands; the bottom unless asked otherwise. */
  placement: z.enum(['top', 'bottom']).default('bottom')
})

export const ticketUpdateSchema = z.object(ticketShape).partial()

export const importedTicketUpdateSchema = ticketUpdateSchema.omit({ buildNumber: true }).extend({
  title: z.string().trim().min(1, 'Title is required.').max(10000).optional(),
  // Board admins only, enforced by the handler: an imported ticket arrives unattributed, and
  // whoever really filed it can be named afterwards.
  authorId: idSchema.nullable().optional()
})

export const ticketMoveSchema = z.object({
  laneId: idSchema,
  index: z.number().int().min(0).max(10000)
})

export const ticketTransferSchema = z.object({
  boardId: idSchema,
  /** A lane of the destination board; its default lane when omitted. */
  laneId: idSchema.optional()
})

export const boardCreateSchema = z.object({
  name: z.string().trim().min(1, 'A board name is required.').max(40),
  /** Omitted lands the board in the default workspace, so pre-workspace clients keep working. */
  workspaceId: idSchema.optional()
})

export const workspaceCreateSchema = z.object({
  name: z.string().trim().min(1, 'A workspace name is required.').max(40)
})

export const workspaceUpdateSchema = z.object({
  name: z.string().trim().min(1, 'A workspace name is required.').max(40),
  description: z.string().trim().max(200, 'A workspace description is at most 200 characters.')
}).partial()

export const workspaceMemberSchema = z.object({
  role: z.enum(workspaceRoles)
})

export const workspaceBoardOrderSchema = z.object({
  boardIds: z.array(idSchema).min(1).max(100)
})

export const boardUpdateSchema = z.object({
  name: z.string().trim().min(1, 'A board name is required.').max(40),
  description: z.string().trim().max(200, 'A board description is at most 200 characters.'),
  issuerId: z.string().trim().max(120),
  keyId: z.string().trim().max(120),
  appId: z.string().trim().max(120),
  syncLimit: z.number().int().min(1, 'Sync at least one submission.').max(2000, 'At most 2000 submissions per sync.'),
  autoAuthor: z.boolean(),
  /** A type of the board's workspace; null clears it. Omitted leaves it as it is. */
  importTypeId: idSchema.nullable(),
  /** The Jira connection minus its token, which travels on its own route like the .p8 does. */
  jira: z.object({
    // A pasted issue link is reduced to its site first, so it does not fail for its path.
    siteUrl: z.string().trim().max(200).transform(normalizeSiteUrl).refine(value => value === '' || isJiraSiteUrl(value), 'Enter the Jira site as https://<team>.atlassian.net.'),
    email: z.string().trim().max(200),
    jql: z.string().trim().max(2000, 'A JQL query is at most 2000 characters.')
  }).partial()
}).partial()

/** The connection test checks the credentials the user has on screen, so they travel in the request. */
export const connectionTestSchema = boardUpdateSchema.pick({ issuerId: true, keyId: true, appId: true })

/** Same idea for Jira: the form's draft values, with the token always coming from the vault. */
export const jiraConnectionTestSchema = boardUpdateSchema.shape.jira.unwrap()

export const jiraTokenSchema = z.object({
  token: z.string().trim().min(1, 'Paste the API token.').max(1024)
})

export const categoryUpdateSchema = z.object({
  name: z.string().trim().min(1, 'A category name is required.').max(30),
  color: z.enum(categoryColors)
}).partial()

/**
 * An uploaded icon arrives as the PNG the browser already cropped square. Only PNG: it is
 * what `canvas.toDataURL` produces, and one format is one format to reason about.
 */
export const ticketTypeIconInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lucide'), name: z.enum(ticketTypeIconNames) }),
  z.object({
    kind: z.literal('image'),
    dataUrl: z.string()
      .max(TICKET_TYPE_ICON_DATA_URL_MAX, 'The icon image is too large.')
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/, 'The icon must be a PNG data URL.')
  })
])

export const ticketTypeCreateSchema = z.object({
  name: z.string().trim().min(1, 'A type name is required.').max(30),
  color: z.enum(ticketTypeColors).default('neutral'),
  icon: ticketTypeIconInputSchema.default({ kind: 'lucide', name: 'Ticket' })
})

export const ticketTypeUpdateSchema = z.object({
  name: z.string().trim().min(1, 'A type name is required.').max(30),
  color: z.enum(ticketTypeColors),
  icon: ticketTypeIconInputSchema
}).partial()

export const ticketTypeOrderSchema = z.object({
  typeIds: z.array(idSchema).min(1).max(100)
})

export const laneCreateSchema = z.object({
  name: z.string().trim().min(1, 'A lane name is required.').max(30)
})

export const laneUpdateSchema = z.object({
  name: z.string().trim().min(1, 'A lane name is required.').max(30)
}).partial()

export const laneDeleteSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('move'), targetLaneId: idSchema }),
  z.object({ mode: z.literal('archive') })
])

export const laneOrderSchema = z.object({
  laneIds: z.array(idSchema).min(1).max(30)
})

export const importRequestSchema = z.object({
  boardId: idSchema,
  /** Which of the board's connections to pull from. Absent means TestFlight, as before there was a choice. */
  provider: z.enum(integrationProviders).default('testflight')
})

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(512)
})

const nameSchema = z.string().trim().min(1, 'A name is required.').max(60)

export const userCreateSchema = z.object({
  email: emailSchema,
  firstName: nameSchema,
  lastName: z.string().trim().max(60).default(''),
  role: z.enum(userRoles).exclude(['owner']).default('member')
})

export const userUpdateSchema = z.object({
  email: emailSchema,
  firstName: nameSchema,
  lastName: z.string().trim().max(60),
  role: z.enum(userRoles).exclude(['owner']),
  status: z.enum(userStatuses).exclude(['invited'])
}).partial()

export const profileUpdateSchema = z.object({
  email: emailSchema,
  firstName: nameSchema,
  lastName: z.string().trim().max(60)
}).partial()

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: passwordSchema
})

export const inviteAcceptSchema = z.object({
  password: passwordSchema
})

export const boardMemberSchema = z.object({
  role: z.enum(boardRoles),
  /** Omitted leaves an existing membership's permission alone; a new one starts without it. */
  mayAutomate: z.boolean().optional()
})

export const commentSaveSchema = z.object({
  body: z.string().trim().min(1, 'A comment cannot be empty.').max(10000)
})

export function validationError(error: z.ZodError) {
  return createError({ statusCode: 422, statusMessage: 'Invalid input', data: { issues: z.treeifyError(error) } })
}
