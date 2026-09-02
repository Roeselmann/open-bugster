# Webhooks

A board can push its events to another system instead of being polled: n8n, a chat channel, a build pipeline. Deliveries are signed, retried, and logged, and destinations are screened before anything is sent.

## Using it

Under **Board settings → Webhooks**, a board administrator adds a destination URL and picks the events it should receive. The signing secret is generated on creation and shown once. Each webhook can be paused, edited, and deleted, and every delivery attempt of the last seven days is visible beneath it with its status and response.

The events:

| Event | Fires when |
|---|---|
| `ticket.created` | A ticket is created, by hand or through the API. |
| `ticket.updated` | Fields of a ticket change. |
| `ticket.moved` | A ticket changes lane or position. |
| `ticket.archived`, `ticket.restored` | A ticket leaves or returns to the board. |
| `comment.added` | A comment is posted. |
| `import.completed` | A TestFlight sync finishes. |

Each delivery is a JSON body with the event name, a timestamp, the board, and a `data` object holding the ticket, comment, or import run. The exact shape of each event is documented inside the app under the reference panel next to the event picker.

### Verifying a delivery

Each delivery carries `X-Bugster-Signature: t=<unix>,v1=<hmac-sha256>`, computed over `<timestamp>.<body>` with the webhook's secret. A receiver recomputes the HMAC, compares in constant time, and rejects timestamps older than five minutes, which rules out replays.

### Private destinations

Deliveries go to private addresses by default, because an n8n is usually on the same Docker network. Set `WEBHOOK_ALLOW_PRIVATE=false` to allow public destinations only. The cloud metadata range is refused either way. The same switch and the same screening govern the URLs the server downloads attachments from.

## How it works

- **Events come from operations.** `eventForOperation` maps an operation name to an event, and the operation runner calls `dispatch` after a successful run. An operation absent from the map sends nothing; adding an event means adding one line there and one entry to the shared catalogue, and a test checks the two agree.
- **Dispatch is fire-and-forget.** The runner fans out synchronously to the board's enabled webhooks that subscribe to the event, and each delivery runs asynchronously so a slow receiver never delays the request.
- **Retries** happen up to five times with a widening backoff of one, four, nine, and sixteen seconds (attempt squared, times a base that tests can shorten). A request times out after ten seconds. A webhook whose deliveries exhaust their retries twenty times in a row is disabled automatically.
- **Destination screening** (`assertDeliverable`) refuses anything that is not http or https, URLs carrying credentials, and link-local addresses always; private ranges only when `WEBHOOK_ALLOW_PRIVATE` is false. The check runs when the webhook is saved and again before every delivery, since a hostname can change what it resolves to.
- **Secrets** are `whsec_<base64url>`, generated at creation and returned once.
- **Delivery attempts** are a diagnostic, not a record, and are pruned after seven days at startup.

## Code map

| File | What lives there |
|---|---|
| [server/utils/webhook.ts](../server/utils/webhook.ts) | `webhookEvents`, `eventForOperation`, `assertDeliverable`, `allowPrivateTargets`, the CRUD functions, `signPayload`, `verifySignature`, `dispatch`, `deliver`, `pruneDeliveries`. |
| [shared/utils/webhook-catalogue.ts](../shared/utils/webhook-catalogue.ts) | `WEBHOOK_DELIVERY` (the retry, timeout, and tolerance numbers) and `WEBHOOK_EVENTS` (each event's trigger and `data` key). The single source the UI renders from. |
| [server/operations/webhooks.ts](../server/operations/webhooks.ts) | `webhook.list`, `webhook.create`, `webhook.update`, `webhook.delete`, `webhook.deliveries`, all board admin. |
| [server/operations/run.ts](../server/operations/run.ts) | `announce`, the call after a successful mutation. |
| [server/utils/attachment-fetch.ts](../server/utils/attachment-fetch.ts) | Reuses the destination screening for server-side downloads. |
| [server/utils/db.ts](../server/utils/db.ts) | `ensureWebhooks`; tables `webhooks`, `webhook_deliveries`. |
| [server/plugins/audit-retention.ts](../server/plugins/audit-retention.ts) | The startup prune of old attempts. |
| `app/components/WebhookEventPicker.vue`, `WebhookReference.vue` | The event picker and the payload reference. |
| `app/pages/b/[board]/settings/automation.vue` | The settings section. |

## Surfaces

- **Internal routes:** `server/api/boards/[id]/webhooks/index.get.ts`, `index.post.ts`; `server/api/webhooks/[id].patch.ts`, `[id].delete.ts`, `[id]/deliveries.get.ts`.
- **REST v1:** none. Webhook management stays in the UI.
- **MCP:** none.

## Tests

- `tests/webhook.test.ts`: destination screening, signing and verification, delivery, retry, auto-disable, and that the catalogue matches the server's event list.

## Configuration

| Variable | Purpose |
|---|---|
| `WEBHOOK_ALLOW_PRIVATE` | `true` by default. `false` refuses private address ranges for webhooks and attachment downloads. |
| `WEBHOOK_RETRY_BASE_MS` | The retry base in milliseconds; a test hook, 1000 by default. |
