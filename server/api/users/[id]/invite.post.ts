import { run, userInvite } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'
import { inviteUrl } from '~~/server/utils/invite'

export default defineEventHandler(async (event) => {
  const { inviteToken, purpose } = await run(userInvite, sessionActor(event), { userId: getRouterParam(event, 'id') || '' }) as { inviteToken: string; purpose: string }
  return { inviteUrl: inviteUrl(getRequestURL(event).origin, inviteToken), purpose }
})
