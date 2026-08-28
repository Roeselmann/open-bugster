import { run, categoryList } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event =>
  run(categoryList, sessionActor(event), { boardId: String(getQuery(event).boardId || '') }))
