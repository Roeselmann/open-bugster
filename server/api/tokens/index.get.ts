import { run, tokenList } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler((event) => {
  const principalId = String(getQuery(event).principalId || '') || undefined
  return run(tokenList, sessionActor(event), { principalId })
})
