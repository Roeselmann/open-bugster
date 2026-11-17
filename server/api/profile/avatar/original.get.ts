import { sessionActor } from '~~/server/utils/actor'
import { getUserAvatarSource } from '~~/server/utils/db'

/** The photo your own portrait was cut from, for moving the cut. Nobody else's. */
export default defineEventHandler((event) => {
  const source = getUserAvatarSource(sessionActor(event).principal.id)
  if (!source) throw createError({ statusCode: 404, statusMessage: 'No photo.' })
  setResponseHeaders(event, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  })
  return source.original
})
