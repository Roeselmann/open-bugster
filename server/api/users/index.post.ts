import { run, userCreate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'
import { inviteUrl } from '~~/server/utils/invite'

export default defineEventHandler(async (event) => {
  const { user, inviteToken } = await run(userCreate, sessionActor(event), await readBody(event)) as { user: unknown; inviteToken: string }
  setResponseStatus(event, 201)
  // The only time the raw token is ever visible. It is not stored anywhere in the clear.
  return { user, inviteUrl: inviteUrl(getRequestURL(event).origin, inviteToken) }
})
