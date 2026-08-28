import { AnonymizedAccountError, findUser, setInviteToken } from '~~/server/utils/db'
import { requireInstanceAdmin } from '~~/server/utils/access'
import { createInviteToken, invitePurpose, inviteUrl } from '~~/server/utils/invite'

/**
 * Issues the link that lets somebody set a password: an invitation for an account that has
 * never signed in, and a reset for one whose password was forgotten. Both are the same
 * single-use link, so a forgotten password never has to be handed over out of band.
 */
export default defineEventHandler((event) => {
  const account = requireInstanceAdmin(event)
  const id = getRouterParam(event, 'id') || ''
  const target = findUser(id)
  if (!target) throw createError({ statusCode: 404, statusMessage: 'Account not found.' })
  if (target.anonymizedAt) throw createError({ statusCode: 409, statusMessage: new AnonymizedAccountError().message })
  // A reset link sets a password and signs the holder in, so it would be a way around both
  // of the rules the rest of this admin area keeps: that a disabled account stays out, and
  // that an administrator cannot take the owner's account.
  if (target.status === 'disabled') {
    throw createError({ statusCode: 409, statusMessage: 'Enable the account before issuing a link for it.' })
  }
  if (target.role === 'owner' && target.id !== account.id) {
    throw createError({ statusCode: 409, statusMessage: 'Only the owner can set the owner account password.' })
  }
  const invite = createInviteToken()
  setInviteToken(id, invite.hash, invite.expiresAt)
  return { inviteUrl: inviteUrl(event, invite.token), purpose: invitePurpose(target) }
})
