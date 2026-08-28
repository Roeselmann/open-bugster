import { run, labelList } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(labelList, sessionActor(event), { boardId: String(getQuery(event).boardId || '') }))
