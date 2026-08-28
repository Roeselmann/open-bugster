import { run, serviceList } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event => run(serviceList, sessionActor(event), {}))
