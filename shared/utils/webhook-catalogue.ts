/**
 * What a webhook receiver is told, in one place.
 *
 * The settings page builds both its event picker and its reference from this, so the list a
 * board admin ticks and the list the documentation describes cannot drift apart. The delivery
 * numbers are imported by `server/utils/webhook.ts` rather than restated here, so the page
 * cannot promise a retry schedule the sender does not keep.
 *
 * `tests/webhook.test.ts` holds this against the server's own event list.
 */

/** The rules a receiver has to live with. The sender reads these; the page prints them. */
export const WEBHOOK_DELIVERY = {
  /** Attempts per event, the first one included. */
  maxAttempts: 5,
  /** The backoff step, squared per attempt: 1s, 4s, 9s, 16s. */
  retryBaseSeconds: 1,
  /** Consecutive events that exhausted every attempt before the webhook is switched off. */
  failuresBeforeDisabling: 20,
  /** How long a receiver has to answer before the attempt counts as failed. */
  requestTimeoutSeconds: 10,
  /** How long the attempt log is kept, so a delivery can be looked up after the fact. */
  deliveryLogDays: 7,
  /** What a receiver should accept as the age of a signature, to reject replays. */
  signatureToleranceSeconds: 300
} as const

export interface WebhookEventDoc {
  /** The value of `event` in the body and of the `X-Bugster-Event` header. */
  event: string
  /** The operation that produces it — the same name the audit log and the API use. */
  operation: string
  /** When it fires, in a sentence. */
  fires: string
  /** The single key inside `data`. */
  dataKey: 'ticket' | 'comment' | 'run'
  /** What that key holds. */
  holds: string
}

/**
 * Every event a board can send, in the order the picker shows them.
 *
 * `ticket.updated` covers every field change rather than splitting per field: a workflow that
 * cares which one moved can read the ticket in the payload.
 */
export const WEBHOOK_EVENTS: readonly WebhookEventDoc[] = [
  {
    event: 'ticket.created',
    operation: 'ticket.create',
    fires: 'A ticket was filed from the board, through the API, or by an agent. A TestFlight import does not fire this — it writes its tickets straight in and reports itself as `import.completed`.',
    dataKey: 'ticket',
    holds: 'The new ticket in full.'
  },
  {
    event: 'ticket.updated',
    operation: 'ticket.update',
    fires: 'Any field of a ticket changed: title, description, priority, due date, assignee, labels, category, todos.',
    dataKey: 'ticket',
    holds: 'The whole ticket as it stands after the change. The payload does not say which field moved — compare against what you hold, or read the ticket’s history.'
  },
  {
    event: 'ticket.moved',
    operation: 'ticket.move',
    fires: 'A ticket changed lane or position.',
    dataKey: 'ticket',
    holds: 'The ticket, with its new `laneId` and `position`.'
  },
  {
    event: 'ticket.archived',
    operation: 'ticket.archive',
    fires: 'A ticket was taken off the board.',
    dataKey: 'ticket',
    holds: 'The ticket, with `archivedAt` set.'
  },
  {
    event: 'ticket.restored',
    operation: 'ticket.restore',
    fires: 'An archived ticket was put back on the board.',
    dataKey: 'ticket',
    holds: 'The ticket, with `archivedAt` back to null.'
  },
  {
    event: 'comment.added',
    operation: 'comment.add',
    fires: 'Somebody commented on a ticket. Editing or deleting a comment sends nothing.',
    dataKey: 'comment',
    holds: 'The comment, its author, and its full text.'
  },
  {
    event: 'import.completed',
    operation: 'import.run',
    fires: 'A TestFlight sync finished — including when it finished badly.',
    dataKey: 'run',
    holds: 'The run: how many tickets were imported, skipped and failed, and why it stopped. The imported tickets do not arrive as `ticket.created` — read the import lane if the workflow needs them.'
  }
] as const

export const WEBHOOK_EVENT_NAMES: readonly string[] = WEBHOOK_EVENTS.map(entry => entry.event)
