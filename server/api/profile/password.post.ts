import { run, profileChangePassword } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'
import { refreshSession, type SessionUser } from '~~/server/utils/session'

export default defineEventHandler(async (event) => {
  const { user } = await run(profileChangePassword, sessionActor(event), await readBody(event)) as { user: SessionUser }
  await refreshSession(event, user)
  return { ok: true }
})
