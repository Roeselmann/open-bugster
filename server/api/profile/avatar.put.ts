import { profileSetAvatar, run } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

export default defineEventHandler(async event => run(profileSetAvatar, sessionActor(event), await readBody(event)))
