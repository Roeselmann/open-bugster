import { run, userList } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event => run(userList, sessionActor(event), {}))
