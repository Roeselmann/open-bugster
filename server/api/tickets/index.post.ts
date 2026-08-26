import { createTicket } from '~~/server/utils/db'
import { getServerConfig } from '~~/server/utils/config'
import { ticketCreateSchema, validationError } from '~~/server/utils/validation'

export default defineEventHandler(async (event) => {
  const parsed = ticketCreateSchema.safeParse(await readBody(event))
  if (!parsed.success) throw validationError(parsed.error)
  const config = getServerConfig()
  if (!config.adminFirstName || !config.adminLastName || !config.adminEmail) {
    throw createError({ statusCode: 500, statusMessage: 'The administrator identity is not fully configured.' })
  }
  setResponseStatus(event, 201)
  return {
    ticket: createTicket(parsed.data, {
      firstName: config.adminFirstName,
      lastName: config.adminLastName,
      email: config.adminEmail,
    }),
  }
})
