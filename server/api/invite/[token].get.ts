import { accountForInviteToken, invitePurpose } from '~~/server/utils/invite'

export default defineEventHandler((event) => {
  const account = accountForInviteToken(getRouterParam(event, 'token') || '')
  return {
    invite: {
      email: account.email,
      firstName: account.firstName,
      lastName: account.lastName,
      purpose: invitePurpose(account),
    },
  }
})
