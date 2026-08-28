import { run, importRun } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async (event) =>
  run(importRun, sessionActor(event), await readBody(event)))
