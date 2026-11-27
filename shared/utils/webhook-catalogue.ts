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
  /**
   * The operation that produces it — the same name the audit log and the API use — or null
   * for an event the calendar raises rather than a request.
   */
  operation: string | null
  /** When it fires, in a sentence. */
  fires: string
  /** The key inside `data` that holds the subject; the calendar's events add more beside it. */
  dataKey: 'ticket' | 'comment' | 'run'
  /** What that key holds. */
  holds: string
}

/**
 * Every event a board can send, in the order the picker shows them. Each live-window event
 * fires once per ticket and date: moving the window signals again for the new date.
 *
 * `ticket.updated` covers every field change rather than splitting per field: a workflow that
 * cares which one moved can read the ticket in the payload.
 */
export const WEBHOOK_EVENTS: readonly WebhookEventDoc[] = [
  {
    event: 'ticket.created',
    operation: 'ticket.create',
    fires: 'A ticket was filed from the board, through the API, or by an agent. An import does not fire this — it writes its tickets straight in and reports itself as `import.completed`.',
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
    event: 'ticket.transferred',
    operation: 'ticket.transfer',
    fires: 'A ticket moved onto another board of the workspace. Sent to the board it left.',
    dataKey: 'ticket',
    holds: 'The ticket as it stands on its new board: a new `boardId`, `laneId` and `position`. Labels and category were re-created there by name; the assignee is gone when they were no member of that board.'
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
    fires: 'A TestFlight or Jira sync finished — including when it finished badly.',
    dataKey: 'run',
    holds: 'The run: which provider it pulled from, how many tickets were imported, skipped and failed, and why it stopped. The imported tickets do not arrive as `ticket.created` — read the import lane if the workflow needs them.'
  },
  {
    event: 'ticket.went_live',
    operation: null,
    fires: 'The first day of a ticket’s live window (`liveFrom`) has come. Raised by the calendar, not by a request, at most a few minutes into the day in the workspace’s time zone, whatever lane the ticket is in. A go-live more than a week late — the server was down — is not announced.',
    dataKey: 'ticket',
    holds: 'The ticket in full; beside it `data.lane` (`id`, `name`, `isLive` — false means the board has not caught up yet) and `data.date`, the day the window opened. `actor` has no principal and the channel `system`.'
  },
  {
    event: 'ticket.live_ending',
    operation: null,
    fires: 'A ticket in a live lane is within the board’s due-date warning days of the last day of its live window (`liveUntil`): time to renew an approval or plan the take-down.',
    dataKey: 'ticket',
    holds: 'The ticket in full, `data.lane` beside it, and `data.date`, the last day of the window.'
  },
  {
    event: 'ticket.live_ended',
    operation: null,
    fires: 'The last day of a live window has passed and the ticket is still in a live lane: a campaign still out or an approval expired, waiting to be taken down. Not sent once the ticket has left the live lane.',
    dataKey: 'ticket',
    holds: 'The ticket in full, `data.lane` beside it, and `data.date`, the last day of the window.'
  },
  {
    event: 'ticket.new_round',
    operation: 'ticket.round.close',
    fires: 'A recurring ticket’s round closed done or skipped and the next one started: by hand, or by the calendar on the day the next round is due when the card sat in a done or live lane or had every to-do ticked. Also sent for the last round of a series, with no next one.',
    dataKey: 'ticket',
    holds: 'The ticket in full as the new round starts (to-dos reset, back in its return lane, `dueDate` the new round), and beside it `data.round`: `date` of the round that closed, its `outcome` (`done` or `skipped`) and `next`, the new round’s day, or null when the series is over.'
  },
  {
    event: 'ticket.round_missed',
    operation: null,
    fires: 'The next round of a recurring ticket has come while the last one was still open: not in a done or live lane, with to-dos left. Raised by the calendar; the new round starts all the same.',
    dataKey: 'ticket',
    holds: 'The ticket in full as the new round starts, and `data.round` with `date`, `outcome` `missed` and `next`. `actor` has no principal and the channel `system`.'
  }
] as const

export const WEBHOOK_EVENT_NAMES: readonly string[] = WEBHOOK_EVENTS.map(entry => entry.event)
