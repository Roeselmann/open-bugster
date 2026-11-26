import { run, memberCandidates } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  // An exact address reaches an account outside the caller's own workspaces; see `candidateVisibility`.
  const email = getQuery(event).email
  return run(memberCandidates, sessionActor(event), { boardId: getRouterParam(event, 'id') || '', email: typeof email === 'string' && email ? email : undefined })
})
