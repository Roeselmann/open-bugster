import { run, importStatus } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(importStatus, sessionActor(event), { boardId: String(getQuery(event).boardId || '') }))
