import { getUserAvatar } from '~~/server/utils/db'

/**
 * A portrait, for anybody signed in: people see each other's faces wherever they see the
 * names. The address carries the upload time, so the answer never changes and may be kept.
 */
export default defineEventHandler((event) => {
  const avatar = getUserAvatar(getRouterParam(event, 'id') || '')
  if (!avatar) throw createError({ statusCode: 404, statusMessage: 'No picture.' })
  setResponseHeaders(event, {
    'Content-Type': avatar.mime,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  })
  return avatar.data
})
