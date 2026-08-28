import { createError } from 'h3'
import { z } from 'zod'
import {
  WebhookUrlError, assertDeliverable, createWebhook, deleteWebhook, findWebhook,
  listDeliveries, listWebhooks, updateWebhook, webhookEvents
} from '../utils/webhook'
import { createdId, defineOperation } from './types'

const id = z.string().trim().min(1).max(64)
const boardOf = (input: { boardId: string }) => input.boardId

/** A screening failure is the caller's problem to fix, so it reads as a 422. */
async function screened(url: string): Promise<string> {
  try {
    await assertDeliverable(url)
    return url
  } catch (error) {
    if (error instanceof WebhookUrlError) throw createError({ statusCode: 422, statusMessage: error.message })
    throw error
  }
}

/**
 * A webhook belongs to the board whose events it carries, so its administration is the board
 * admin's rather than the instance owner's. The webhook a caller cannot see is on a board they
 * cannot see, and reads as a 404 for the same reason everything else does.
 */
function webhookOnBoard(webhookId: string): string {
  const webhook = findWebhook(webhookId)
  if (!webhook) throw createError({ statusCode: 404, statusMessage: 'Webhook not found.' })
  return webhook.boardId
}

export const webhookList = defineOperation({
  name: 'webhook.list',
  summary: 'List a board’s webhooks',
  input: z.object({ boardId: id }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  audit: false,
  // The secret is never in a listing; it is shown once, when the webhook is created.
  run: (_ctx, input) => ({ webhooks: listWebhooks(input.boardId) })
})

export const webhookCreate = defineOperation({
  name: 'webhook.create',
  summary: 'Send a board’s events somewhere',
  input: z.object({
    boardId: id,
    url: z.string().trim().min(1).max(2000),
    events: z.array(z.enum(webhookEvents)).min(1, 'Choose at least one event.'),
    description: z.string().trim().max(200).optional()
  }),
  requires: { scope: 'board', role: 'admin', boardId: boardOf },
  // The URL and the events, never the signing secret.
  audit: { targetType: 'webhook', targetId: createdId('webhook'), changes: ['url', 'events'] },
  run: async (ctx, input) => {
    const url = await screened(input.url)
    const { webhook, secret } = createWebhook({
      boardId: input.boardId,
      url,
      events: input.events,
      description: input.description,
      createdBy: ctx.account.id
    })
    // The only time the secret is returned. A receiver needs it to verify the signature.
    return { webhook, secret }
  }
})

export const webhookUpdate = defineOperation({
  name: 'webhook.update',
  summary: 'Change a webhook, or switch it back on',
  input: z.object({
    webhookId: id,
    url: z.string().trim().min(1).max(2000).optional(),
    events: z.array(z.enum(webhookEvents)).min(1).optional(),
    enabled: z.boolean().optional(),
    description: z.string().trim().max(200).optional()
  }),
  requires: { scope: 'board', role: 'admin', boardId: input => webhookOnBoard(input.webhookId) },
  audit: { targetType: 'webhook', targetId: input => input.webhookId, changes: ['url', 'events', 'enabled'] },
  run: async (_ctx, input) => {
    if (input.url) await screened(input.url)
    const webhook = updateWebhook(input.webhookId, input)
    if (!webhook) throw createError({ statusCode: 404, statusMessage: 'Webhook not found.' })
    return { webhook }
  }
})

export const webhookDelete = defineOperation({
  name: 'webhook.delete',
  summary: 'Stop sending events somewhere',
  input: z.object({ webhookId: id }),
  requires: { scope: 'board', role: 'admin', boardId: input => webhookOnBoard(input.webhookId) },
  audit: { targetType: 'webhook', targetId: input => input.webhookId },
  run: (_ctx, input) => {
    if (!deleteWebhook(input.webhookId)) throw createError({ statusCode: 404, statusMessage: 'Webhook not found.' })
    return null
  }
})

export const webhookDeliveries = defineOperation({
  name: 'webhook.deliveries',
  summary: 'What happened the last times this webhook fired',
  input: z.object({ webhookId: id, limit: z.number().int().min(1).max(200).optional() }),
  requires: { scope: 'board', role: 'admin', boardId: input => webhookOnBoard(input.webhookId) },
  audit: false,
  run: (_ctx, input) => ({ deliveries: listDeliveries(input.webhookId, input.limit ?? 50) })
})
