import { createError } from 'h3'
import { z } from 'zod'
import { requireBoardAccess, requireWorkspaceAccess } from '../utils/access'
import {
  createTicketType, deleteTicketType, findBoard, findTicketType, listTicketTypes, reorderTicketTypes,
  TicketTypeNameTakenError, updateTicketType
} from '../utils/db'
import { ticketTypeCreateSchema, ticketTypeOrderSchema, ticketTypeUpdateSchema } from '../utils/validation'
import { createdId, defineOperation } from './types'
import { orNotFound } from './run'

const id = z.string().trim().min(1).max(64)

/**
 * Reading the list is reached two ways on purpose. The editor on a board needs the types of
 * that board's workspace, and a board-pinned token — which `requireWorkspaceAccess` turns
 * away from every workspace by design — still has to fill in a type. Naming the board keeps
 * the board's own access rule in charge; naming the workspace is what the settings page does.
 */
export const ticketTypeList = defineOperation({
  name: 'ticket.type.list',
  summary: 'List a workspace’s ticket types',
  input: z.object({
    workspaceId: id.optional(),
    boardId: id.optional().describe('Instead of workspaceId: the types of the workspace this board is in.')
  }),
  requires: { scope: 'authenticated' },
  audit: false,
  run: (ctx, input) => {
    let workspaceId = input.workspaceId
    if (input.boardId) {
      requireBoardAccess(ctx.actor, input.boardId, 'viewer')
      workspaceId = orNotFound(findBoard(input.boardId), 'Board').workspaceId
    } else if (workspaceId) {
      requireWorkspaceAccess(ctx.actor, workspaceId, 'member')
    } else {
      throw createError({ statusCode: 422, statusMessage: 'Name a workspace or a board.' })
    }
    return { types: listTicketTypes(workspaceId) }
  }
})

// The icon is never in a `changes` list: an uploaded one is a data URL of up to 64 KB, and
// the audit log records that the icon changed, not what it became.
export const ticketTypeCreate = defineOperation({
  name: 'ticket.type.create',
  summary: 'Add a ticket type to a workspace',
  input: ticketTypeCreateSchema.extend({ workspaceId: id }),
  requires: { scope: 'workspace', role: 'admin', workspaceId: input => input.workspaceId },
  audit: { targetType: 'ticketType', targetId: createdId('type'), changes: ['workspaceId', 'name', 'color'] },
  run: (_ctx, input) => {
    try {
      return { type: orNotFound(createTicketType(input.workspaceId, input), 'Workspace') }
    } catch (error) {
      if (error instanceof TicketTypeNameTakenError) throw createError({ statusCode: 409, statusMessage: error.message })
      throw error
    }
  }
})

export const ticketTypeUpdate = defineOperation({
  name: 'ticket.type.update',
  summary: 'Rename, recolour or re-icon a ticket type',
  input: ticketTypeUpdateSchema.extend({ typeId: id }),
  requires: { scope: 'workspace', role: 'admin', workspaceId: input => typeWorkspace(input.typeId) },
  audit: { targetType: 'ticketType', targetId: input => input.typeId, changes: input => ({ fields: Object.keys(input).filter(key => key !== 'typeId').sort() }) },
  run: (_ctx, input) => {
    try {
      return { type: orNotFound(updateTicketType(input.typeId, input), 'Ticket type') }
    } catch (error) {
      if (error instanceof TicketTypeNameTakenError) throw createError({ statusCode: 409, statusMessage: error.message })
      throw error
    }
  }
})

/** Tickets of the type are not touched beyond losing it — they become untyped. */
export const ticketTypeDelete = defineOperation({
  name: 'ticket.type.delete',
  summary: 'Remove a ticket type from a workspace',
  input: z.object({ typeId: id }),
  requires: { scope: 'workspace', role: 'admin', workspaceId: input => typeWorkspace(input.typeId) },
  audit: { targetType: 'ticketType', targetId: input => input.typeId },
  run: (_ctx, input) => {
    if (!deleteTicketType(input.typeId)) throw createError({ statusCode: 404, statusMessage: 'Ticket type not found.' })
    return null
  }
})

export const ticketTypeReorder = defineOperation({
  name: 'ticket.type.reorder',
  summary: 'Set the order of a workspace’s ticket types',
  input: ticketTypeOrderSchema.extend({ workspaceId: id }),
  requires: { scope: 'workspace', role: 'admin', workspaceId: input => input.workspaceId },
  audit: { targetType: 'workspace', targetId: input => input.workspaceId, changes: ['typeIds'] },
  run: (_ctx, input) => {
    const types = reorderTicketTypes(input.workspaceId, input.typeIds)
    if (!types) throw createError({ statusCode: 422, statusMessage: 'The new order must list every type of this workspace exactly once.' })
    return { types }
  }
})

/** Same shape as `categoryBoard`: an unknown type is a 404 the access layer would give anyway. */
function typeWorkspace(typeId: string): string {
  return orNotFound(findTicketType(typeId), 'Ticket type').workspaceId
}
