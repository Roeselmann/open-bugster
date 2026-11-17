import { profileRemoveAvatar, run } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(event => run(profileRemoveAvatar, sessionActor(event), {}))
