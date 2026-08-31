import { run, workspaceList } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event => run(workspaceList, sessionActor(event), {}))
