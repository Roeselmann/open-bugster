import { createError } from 'h3'
import { z } from 'zod'
import {
  AnonymizedAccountError, EmailTakenError, anonymizeUser, clearInviteToken, createUser, deleteUser,
  findUser, listUsers, setInviteToken, setUserPassword, updateUser, type UserRecord
} from '../utils/db'
import { createInviteToken, invitePurpose } from '../utils/invite'
import { hashStoredPassword, verifyStoredPassword } from '../utils/password'
import { passwordChangeSchema, profileUpdateSchema, userCreateSchema, userUpdateSchema } from '../utils/validation'
import { createdId, defineOperation } from './types'

const id = z.string().trim().min(1).max(64)

/** No password hash ever leaves an operation, whichever surface asked. */
function publicUser(account: UserRecord) {
  return { ...account, passwordHash: undefined }
}

/** The two errors `users` raises that are really conflicts rather than faults. */
function asConflict<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    if (error instanceof EmailTakenError || error instanceof AnonymizedAccountError) {
      throw createError({ statusCode: 409, statusMessage: error.message })
    }
    throw error
  }
}

function targetOrNotFound(userId: string): UserRecord {
  const target = findUser(userId)
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Account not found.' })
  return target
}

export const userList = defineOperation({
  name: 'user.list',
  summary: 'List the accounts on this instance',
  input: z.object({}),
  requires: { scope: 'instance' },
  audit: false,
  run: () => ({ users: listUsers() })
})

/**
 * The raw invite token is returned, never the finished link: the URL has to be built from the
 * address the browser actually reached, which only the transport knows. A caller-supplied
 * origin would turn this into a way to mint a link pointing anywhere.
 *
 * The token is not in the audit allowlist, so it cannot reach the log either.
 */
export const userCreate = defineOperation({
  name: 'user.create',
  summary: 'Invite somebody to the instance',
  input: userCreateSchema,
  requires: { scope: 'instance' },
  // The role, not the address: this log stays free of anything that identifies a person, so
  // that anonymizing them empties it without a single row being rewritten.
  audit: { targetType: 'user', targetId: createdId('user'), changes: ['role'] },
  run: (_ctx, input) => {
    const account = asConflict(() => createUser(input))
    const invite = createInviteToken()
    setInviteToken(account.id, invite.hash, invite.expiresAt)
    return { user: publicUser(account), inviteToken: invite.token }
  }
})

export const userUpdate = defineOperation({
  name: 'user.update',
  summary: 'Change an account’s details, role or status',
  input: userUpdateSchema.extend({ userId: id }),
  requires: { scope: 'instance' },
  audit: {
    targetType: 'user',
    targetId: input => input.userId,
    // Role and status by value, because who gained what is the point of the entry. Names and
    // addresses by field name only.
    changes: input => ({
      fields: Object.keys(input).filter(key => key !== 'userId').sort(),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.status !== undefined ? { status: input.status } : {})
    })
  },
  run: (ctx, input) => {
    const { userId, ...fields } = input
    const target = targetOrNotFound(userId)
    const changesAccess = fields.role !== undefined || fields.status !== undefined

    if (target.role === 'owner' && changesAccess) {
      throw createError({ statusCode: 409, statusMessage: 'The owner account cannot be demoted or disabled.' })
    }
    if (target.id === ctx.account.id && changesAccess) {
      throw createError({ statusCode: 409, statusMessage: 'You cannot change your own role or status.' })
    }
    return { user: publicUser(asConflict(() => updateUser(userId, fields)!)) }
  }
})

export const userDelete = defineOperation({
  name: 'user.delete',
  summary: 'Remove an account outright',
  input: z.object({ userId: id }),
  requires: { scope: 'instance' },
  audit: { targetType: 'user', targetId: input => input.userId },
  run: (ctx, input) => {
    const target = targetOrNotFound(input.userId)
    if (target.role === 'owner') throw createError({ statusCode: 409, statusMessage: 'The owner account cannot be deleted.' })
    if (target.id === ctx.account.id) throw createError({ statusCode: 409, statusMessage: 'You cannot delete your own account.' })
    // Tickets, comments, and activity keep pointing where they did, so the history stays
    // readable — it simply stops resolving to an account.
    deleteUser(input.userId)
    return null
  }
})

export const userAnonymize = defineOperation({
  name: 'user.anonymize',
  summary: 'Strip an account’s identity while keeping its history',
  input: z.object({ userId: id }),
  requires: { scope: 'instance' },
  audit: { targetType: 'user', targetId: input => input.userId },
  run: (ctx, input) => {
    const target = targetOrNotFound(input.userId)
    if (target.role === 'owner') throw createError({ statusCode: 409, statusMessage: 'The owner account cannot be anonymized.' })
    if (target.id === ctx.account.id) throw createError({ statusCode: 409, statusMessage: 'You cannot anonymize your own account.' })
    // Everything this person touched keeps pointing at the row and stays where it is; what
    // goes is the name, the address, and any way back into the account.
    return { user: publicUser(anonymizeUser(input.userId)!) }
  }
})

export const userInvite = defineOperation({
  name: 'user.invite',
  summary: 'Issue a fresh sign-in or password-reset link',
  input: z.object({ userId: id }),
  requires: { scope: 'instance' },
  audit: { targetType: 'user', targetId: input => input.userId },
  run: (ctx, input) => {
    const target = targetOrNotFound(input.userId)
    if (target.anonymizedAt) throw createError({ statusCode: 409, statusMessage: new AnonymizedAccountError().message })
    // A reset link sets a password and signs the holder in, so it would be a way around both
    // of the rules the rest of this admin area keeps: that a disabled account stays out, and
    // that an administrator cannot take the owner's account.
    if (target.status === 'disabled') {
      throw createError({ statusCode: 409, statusMessage: 'Enable the account before issuing a link for it.' })
    }
    if (target.role === 'owner' && target.id !== ctx.account.id) {
      throw createError({ statusCode: 409, statusMessage: 'Only the owner can set the owner account password.' })
    }
    const invite = createInviteToken()
    setInviteToken(input.userId, invite.hash, invite.expiresAt)
    return { inviteToken: invite.token, purpose: invitePurpose(target) }
  }
})

export const userRevokeInvite = defineOperation({
  name: 'user.revokeInvite',
  summary: 'Stop an outstanding link from working',
  input: z.object({ userId: id }),
  requires: { scope: 'instance' },
  audit: { targetType: 'user', targetId: input => input.userId },
  run: (_ctx, input) => {
    targetOrNotFound(input.userId)
    // The account stays; only the link stops working. Issuing a new one is a separate step,
    // so a misdirected invitation can be killed without handing out a replacement.
    clearInviteToken(input.userId)
    return null
  }
})

/* ── the caller's own account ───────────────────────────────────────────── */

export const profileUpdate = defineOperation({
  name: 'profile.update',
  summary: 'Change your own name or address',
  input: profileUpdateSchema,
  requires: { scope: 'authenticated' },
  audit: { targetType: 'user', changes: input => ({ fields: Object.keys(input).sort() }) },
  run: (ctx, input) => ({ user: publicUser(asConflict(() => updateUser(ctx.account.id, input)!)) })
})

/**
 * Nothing about this reaches the audit log but the fact that it happened — no field names, no
 * lengths, nothing derived from either password.
 */
export const profileChangePassword = defineOperation({
  name: 'profile.changePassword',
  summary: 'Change your own password',
  input: passwordChangeSchema,
  requires: { scope: 'authenticated' },
  audit: { targetType: 'user' },
  run: (ctx, input) => {
    const account = ctx.account
    if (!account.passwordHash || !verifyStoredPassword(input.currentPassword, account.passwordHash)) {
      throw createError({ statusCode: 401, statusMessage: 'The current password is incorrect.' })
    }
    // Bumps the session version, so every other signed-in device is logged out.
    return { user: publicUser(setUserPassword(account.id, hashStoredPassword(input.newPassword))!) }
  }
})
