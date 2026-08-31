import { createError } from 'h3'
import { z } from 'zod'
import { boardViewer } from '../utils/access'
import {
  countWorkspaceBoards, countWorkspaces, createWorkspace, deleteWorkspace, findWorkspaceSummary,
  listUsers, listWorkspaces, removeWorkspaceMember, reorderWorkspaceBoards, setWorkspaceMember,
  updateWorkspace, workspaceMembers
} from '../utils/db'
import { workspaceBoardOrderSchema, workspaceCreateSchema, workspaceMemberSchema, workspaceUpdateSchema } from '../utils/validation'
import { createdId, defineOperation } from './types'
import { orNotFound } from './run'

const id = z.string().trim().min(1).max(64)
const workspaceOf = (input: { workspaceId: string }) => input.workspaceId

export const workspaceList = defineOperation({
  name: 'workspace.list',
  summary: 'List the workspaces the caller can see',
  input: z.object({}),
  requires: { scope: 'authenticated' },
  audit: false,
  run: ctx => ({ workspaces: listWorkspaces(boardViewer(ctx.account)) })
})

export const workspaceCreate = defineOperation({
  name: 'workspace.create',
  summary: 'Open a new workspace',
  // Instance-level like the container it is: workspaces carve up the whole server, so who
  // may add one is the operator's call, not any single workspace's.
  input: workspaceCreateSchema,
  requires: { scope: 'instance' },
  audit: { targetType: 'workspace', targetId: createdId('workspace'), changes: ['name'] },
  run: (ctx, input) => ({ workspace: createWorkspace(input.name, ctx.account.id) })
})

export const workspaceUpdate = defineOperation({
  name: 'workspace.update',
  summary: 'Rename a workspace',
  input: workspaceUpdateSchema.extend({ workspaceId: id }),
  requires: { scope: 'workspace', role: 'admin', workspaceId: workspaceOf },
  audit: { targetType: 'workspace', targetId: input => input.workspaceId, changes: ['name'] },
  run: (ctx, input) => ({ workspace: orNotFound(updateWorkspace(input.workspaceId, input, boardViewer(ctx.account)), 'Workspace') })
})

export const workspaceDelete = defineOperation({
  name: 'workspace.delete',
  summary: 'Delete an empty workspace',
  input: z.object({ workspaceId: id }),
  requires: { scope: 'instance' },
  audit: { targetType: 'workspace', targetId: input => input.workspaceId },
  run: (_ctx, input) => {
    if (countWorkspaces() <= 1) throw createError({ statusCode: 409, statusMessage: 'The last workspace cannot be deleted.' })
    // Boards are never deleted as a side effect of anything — each one goes through its own
    // `board.delete`, with its own audit entry and its own attachment cleanup.
    const boards = countWorkspaceBoards(input.workspaceId)
    if (boards > 0) throw createError({ statusCode: 409, statusMessage: `This workspace still holds ${boards === 1 ? 'a board' : `${boards} boards`}. Move or delete them first.` })
    if (!deleteWorkspace(input.workspaceId)) throw createError({ statusCode: 404, statusMessage: 'Workspace not found.' })
    return null
  }
})

export const workspaceBoardOrder = defineOperation({
  name: 'workspace.reorderBoards',
  summary: 'Set the order of a workspace’s boards',
  input: workspaceBoardOrderSchema.extend({ workspaceId: id }),
  requires: { scope: 'workspace', role: 'admin', workspaceId: workspaceOf },
  audit: { targetType: 'workspace', targetId: input => input.workspaceId, changes: ['boardIds'] },
  run: (_ctx, input) => {
    if (!reorderWorkspaceBoards(input.workspaceId, input.boardIds)) {
      throw createError({ statusCode: 422, statusMessage: 'The new order must list every board of this workspace exactly once.' })
    }
    return null
  }
})

export const workspaceMemberSet = defineOperation({
  name: 'workspace.member.set',
  summary: 'Add somebody to a workspace, or change the role they hold',
  input: workspaceMemberSchema.extend({ workspaceId: id, userId: id }),
  requires: { scope: 'workspace', role: 'admin', workspaceId: workspaceOf },
  audit: { targetType: 'user', targetId: input => input.userId, changes: ['role'] },
  run: (ctx, input) => {
    const member = setWorkspaceMember(input.workspaceId, input.userId, input.role)
    if (!member) throw createError({ statusCode: 404, statusMessage: 'This account does not exist.' })
    return { member, workspace: findWorkspaceSummary(input.workspaceId, boardViewer(ctx.account)) }
  }
})

export const workspaceMemberRemove = defineOperation({
  name: 'workspace.member.remove',
  summary: 'Take somebody off a workspace',
  input: z.object({ workspaceId: id, userId: id }),
  requires: { scope: 'workspace', role: 'admin', workspaceId: workspaceOf },
  audit: { targetType: 'user', targetId: input => input.userId },
  // No last-admin guard, unlike boards: a workspace with no admins at all is the normal
  // state — the migration creates the default one member-less — and instance admins hold
  // every workspace regardless, so nothing can become unreachable.
  run: (ctx, input) => {
    if (!removeWorkspaceMember(input.workspaceId, input.userId)) {
      throw createError({ statusCode: 404, statusMessage: 'This account is not a member of the workspace.' })
    }
    return { workspace: findWorkspaceSummary(input.workspaceId, boardViewer(ctx.account)) }
  }
})

export const workspaceMemberCandidates = defineOperation({
  name: 'workspace.member.candidates',
  summary: 'List accounts that could still be added to a workspace',
  input: z.object({ workspaceId: id }),
  requires: { scope: 'workspace', role: 'admin', workspaceId: workspaceOf },
  audit: false,
  run: (_ctx, input) => {
    const existing = new Set(workspaceMembers(input.workspaceId).map(member => member.userId))
    return {
      candidates: listUsers()
        .filter(user => !existing.has(user.id) && !user.anonymizedAt)
        .map(user => ({ id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, status: user.status }))
    }
  }
})
