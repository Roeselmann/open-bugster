import { z } from 'zod'

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

export const ticketCreateSchema = z.object({
  ...ticketShape,
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
  status: z.enum(['import', 'backlog', 'open', 'question', 'in_progress', 'done']),
  index: z.number().int().min(0).max(10000)
})

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(512)
})

export function validationError(error: z.ZodError) {
  return createError({ statusCode: 422, statusMessage: 'Invalid input', data: { issues: z.treeifyError(error) } })
}
