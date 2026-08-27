import { z } from 'zod'
import { categoryColors } from '../../shared/types/domain'

const labelSchema = z.string().trim().min(1).max(30)
const commentSchema = z.string().max(10000)
const todoSchema = z.object({
  text: z.string().trim().min(1).max(500),
  completed: z.boolean()
})

const ticketShape = {
  title: z.string().trim().min(1, 'Title is required.').max(160),
  description: z.string().max(10000),
  comment: commentSchema,
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  dueDate: z.iso.date().nullable(),
  buildNumber: z.string().trim().max(100).nullable(),
  labels: z.array(labelSchema).max(12),
  categoryName: z.string().trim().max(30).nullable(),
  todos: z.array(todoSchema).max(100)
}

const idSchema = z.string().trim().min(1).max(64)

export const ticketCreateSchema = z.object({
  ...ticketShape,
  boardId: idSchema,
  laneId: idSchema.optional(),
  description: ticketShape.description.default(''),
  comment: ticketShape.comment.default(''),
  priority: ticketShape.priority.default('medium'),
  dueDate: ticketShape.dueDate.optional(),
  buildNumber: ticketShape.buildNumber.optional(),
  labels: ticketShape.labels.default([]),
  categoryName: ticketShape.categoryName.optional(),
  todos: ticketShape.todos.default([])
})

export const ticketUpdateSchema = z.object(ticketShape).partial()

export const importedTicketUpdateSchema = ticketUpdateSchema.omit({ buildNumber: true }).extend({
  title: z.string().trim().min(1, 'Title is required.').max(10000).optional()
})

export const ticketMoveSchema = z.object({
  laneId: idSchema,
  index: z.number().int().min(0).max(10000)
})

export const boardCreateSchema = z.object({
  name: z.string().trim().min(1, 'A board name is required.').max(40)
})

export const boardUpdateSchema = z.object({
  name: z.string().trim().min(1, 'A board name is required.').max(40),
  issuerId: z.string().trim().max(120),
  keyId: z.string().trim().max(120),
  appId: z.string().trim().max(120),
  syncLimit: z.number().int().min(1, 'Sync at least one submission.').max(2000, 'At most 2000 submissions per sync.')
}).partial()

/** The connection test checks the credentials the user has on screen, so they travel in the request. */
export const connectionTestSchema = boardUpdateSchema.pick({ issuerId: true, keyId: true, appId: true })

export const categoryUpdateSchema = z.object({
  name: z.string().trim().min(1, 'A category name is required.').max(30),
  color: z.enum(categoryColors)
}).partial()

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
  boardId: idSchema
})

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(512)
})

export function validationError(error: z.ZodError) {
  return createError({ statusCode: 422, statusMessage: 'Invalid input', data: { issues: z.treeifyError(error) } })
}
