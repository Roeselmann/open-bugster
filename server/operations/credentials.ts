import { createError } from 'h3'
import { z } from 'zod'
import { isInstanceAdmin } from '../utils/access'
import { createServiceIdentity, findPrincipal, listServiceIdentities, setPrincipalStatus } from '../utils/db'
import { createApiToken, findApiToken, listApiTokens, revokeApiToken, tokenScopes } from '../utils/token'
import { createdId, defineOperation } from './types'

const id = z.string().trim().min(1).max(64)

/* ── service identities ─────────────────────────────────────────────────── */

export const serviceList = defineOperation({
  name: 'service.list',
  summary: 'List the machine principals on this instance',
  input: z.object({}),
  requires: { scope: 'instance' },
  audit: false,
  run: () => ({ services: listServiceIdentities().map(service => ({ ...service, passwordHash: undefined })) })
})

export const serviceCreate = defineOperation({
  name: 'service.create',
  summary: 'Open a machine principal that acts through tokens',
  input: z.object({ name: z.string().trim().min(1, 'A name is required.').max(80) }),
  requires: { scope: 'instance' },
  audit: { targetType: 'user', targetId: createdId('service'), changes: ['name'] },
  run: (_ctx, input) => ({ service: { ...createServiceIdentity(input.name), passwordHash: undefined } })
})

export const serviceSetStatus = defineOperation({
  name: 'service.setStatus',
  summary: 'Enable or disable a machine principal',
  input: z.object({ serviceId: id, status: z.enum(['active', 'disabled']) }),
  requires: { scope: 'instance' },
  audit: { targetType: 'user', targetId: input => input.serviceId, changes: ['status'] },
  run: (_ctx, input) => {
    if (!findPrincipal(input.serviceId)) throw createError({ statusCode: 404, statusMessage: 'Account not found.' })
    // Disabling the principal is what stops every one of its tokens at once, so this is
    // deliberately the blunt instrument: no token has to be found and revoked individually.
    const updated = setPrincipalStatus(input.serviceId, input.status)
    if (!updated) throw createError({ statusCode: 409, statusMessage: 'This is not a service identity.' })
    return { service: { ...updated, passwordHash: undefined } }
  }
})

/* ── tokens ─────────────────────────────────────────────────────────────── */

/**
 * Whose tokens the caller may see or touch. Your own always; anybody else's only as an
 * instance administrator — which is also the only way to hold a service identity's tokens,
 * since nobody can sign in as one.
 */
function requireTokenOwnership(callerId: string, isAdmin: boolean, principalId: string) {
  if (principalId !== callerId && !isAdmin) {
    throw createError({ statusCode: 403, statusMessage: 'You can only manage your own tokens.' })
  }
}

export const tokenList = defineOperation({
  name: 'token.list',
  summary: 'List API tokens',
  input: z.object({ principalId: id.optional() }),
  requires: { scope: 'authenticated' },
  audit: false,
  run: (ctx, input) => {
    const target = input.principalId ?? ctx.account.id
    requireTokenOwnership(ctx.account.id, isInstanceAdmin(ctx.account), target)
    return { tokens: listApiTokens(target) }
  }
})

/**
 * The one moment the token itself exists in the clear. Only a hash is kept, so there is no
 * way to show it again — and no way for a copy of the database to hand out working ones.
 */
export const tokenCreate = defineOperation({
  name: 'token.create',
  summary: 'Mint an API token',
  input: z.object({
    name: z.string().trim().min(1, 'A name is required.').max(80),
    principalId: id.optional(),
    /** Shown in the history as the thing that acted: "Claude Desktop", "n8n prod". */
    agentLabel: z.string().trim().max(80).nullable().optional(),
    scopes: z.array(z.enum(tokenScopes)).min(1, 'Choose at least one scope.'),
    boardId: id.nullable().optional(),
    expiresAt: z.iso.datetime().nullable().optional()
  }),
  requires: { scope: 'authenticated' },
  // The scopes and the board, never the token. It is not in the allowlist and so cannot
  // reach the log even if somebody later returns it from somewhere else.
  audit: { targetType: 'token', targetId: createdId('token'), changes: ['name', 'scopes', 'boardId', 'agentLabel', 'principalId'] },
  run: (ctx, input) => {
    const principalId = input.principalId ?? ctx.account.id
    requireTokenOwnership(ctx.account.id, isInstanceAdmin(ctx.account), principalId)

    const principal = findPrincipal(principalId)
    if (!principal) throw createError({ statusCode: 404, statusMessage: 'Account not found.' })
    if (principal.status !== 'active') throw createError({ statusCode: 409, statusMessage: 'This account is not active.' })

    // A token cannot mint a token. Otherwise a leaked read-only credential is one call away
    // from an unrestricted one, and revoking the leaked one no longer helps.
    if (ctx.actor.tokenId) throw createError({ statusCode: 403, statusMessage: 'Tokens cannot be created with a token.' })

    const minted = createApiToken({
      principalId,
      name: input.name,
      agentLabel: input.agentLabel ?? null,
      scopes: input.scopes,
      boardId: input.boardId ?? null,
      expiresAt: input.expiresAt ?? null,
      createdBy: ctx.account.id
    })
    return { token: findApiToken(minted.id)!, secret: minted.token }
  }
})

export const tokenRevoke = defineOperation({
  name: 'token.revoke',
  summary: 'Stop a token from working',
  input: z.object({ tokenId: id }),
  requires: { scope: 'authenticated' },
  audit: { targetType: 'token', targetId: input => input.tokenId },
  run: (ctx, input) => {
    const token = findApiToken(input.tokenId)
    if (!token) throw createError({ statusCode: 404, statusMessage: 'Token not found.' })
    requireTokenOwnership(ctx.account.id, isInstanceAdmin(ctx.account), token.principalId)
    // Revoking twice is not an error: the caller wanted it dead and it is.
    revokeApiToken(input.tokenId)
    return null
  }
})
