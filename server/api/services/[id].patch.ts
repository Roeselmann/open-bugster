import { run, serviceSetStatus, serviceUpdate } from '~~/server/operations'
import { sessionActor } from '~~/server/utils/actor'

/** One route for both edits: a body with a status toggles the agent, anything else renames it. */
export default defineEventHandler(async (event) => {
  const body = await readBody(event) || {}
  const serviceId = getRouterParam(event, 'id') || ''
  const actor = sessionActor(event)
  if (body.status !== undefined && body.name === undefined && body.description === undefined && body.icon === undefined) {
    return run(serviceSetStatus, actor, { status: body.status, serviceId })
  }
  return run(serviceUpdate, actor, { name: body.name, description: body.description, icon: body.icon, serviceId })
})
