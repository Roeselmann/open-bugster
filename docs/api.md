# The API: tokens, REST v1, and the audit trail

Everything the board can do in the browser is also reachable from other software through a versioned REST API, and everything a token does is recorded against the person or service it belongs to. This document covers the credentials, the permission that governs them, the REST surface, and the audit log. The MCP endpoint for agents has [its own document](mcp-server.md), as do [webhooks](webhooks.md).

## Using it

### Tokens

Everything non-browser authenticates with a bearer token. Mint one under **Your profile → Integrations**; it is shown once and only a hash is kept.

```bash
curl -H "Authorization: Bearer bgs_…" https://bugs.example.com/api/v1/boards
```

A token is a **ceiling on what you can already do, never a grant**. A `write` token held by somebody who is a viewer on a board is still a viewer there. A token can be pinned to one board, given an expiry, and revoked at any time, and disabling an account stops all of its tokens at once.

Give a token an **agent label** such as "Claude Desktop" or "n8n prod", and it appears in every ticket's history as *via that label*, beside the person who answers for it.

### Who may integrate with a board

Being on a board and being allowed to drive it from other software are two different things. Every membership carries an **Integration** permission, set per person under **Board settings → Users**, and without it that account's tokens are refused on that board while the browser keeps working. Somebody who holds it on no board is not shown the **Integrations** tab in their profile at all.

It is a second axis rather than a rank above editor: it says *through what* somebody may act, never *how much*. The reasoning is that an editor can already do by hand everything their agent would do; what a token changes is that it happens in bulk and at machine pace, which is worth handing out deliberately. Administrators always hold it, the board's and the instance's alike.

### Agents (service identities)

A token from your profile acts *as you*: what the agent does is recorded against you. When an agent should be a user of its own, with tickets assigned to it and comments under its own name, create it under **Users → Agents** instead. The code calls such a principal a **service identity**; the interface calls it an agent. It suits a CI pipeline or a scheduled job just as well.

- **No address, no password.** An agent has a name and an optional description of what it is for. It cannot sign in and acts only through the tokens an instance administrator makes for it on its row. The same panel shows the MCP connection details.
- **Boards like anybody else.** It is added under **Board settings → Users** with a role and reaches only those boards. Its tokens are its only way in, so its **Integration** box is always ticked and cannot be cleared.
- **Recognisable.** A square avatar and an *Agent* badge in the member list, comments and the history, and "· agent" in the assignee choices.
- **Lifecycle.** Rename it or change its description at any time. Disabling it stops every one of its tokens at once. Deleting it removes the tokens too; its tickets and comments stay but lose the name behind them.
- **Operations:** `service.list`, `service.create`, `service.update`, `service.setStatus`, `service.delete`, all for instance administrators. Over MCP, `whoami` answers `kind: "agent"` with the description, so the agent knows that the tickets assigned to its `principalId` are its own work.

### REST v1

Versioned at `/api/v1`, with the specification generated from the same definitions that validate each request:

- `/api/v1/docs`: the reference, readable in a browser.
- `/api/v1/openapi.json`: OpenAPI 3.1, for a client generator or a self-hosted Swagger UI.

Lists are paged with a cursor, errors are `application/problem+json` with a stable `type`, and any write accepts an `Idempotency-Key` header so a retry replays the first response instead of acting twice. Responses carry `X-RateLimit-*` headers; the default budget is 120 requests per minute per credential.

### The audit trail

**Board settings → Audit** shows every change made on a board and every attempt that was refused, with the person, the agent, and the channel it came through. It holds ids rather than names, so anonymizing somebody empties it of anything identifying without losing the history. Entries older than `AUDIT_RETENTION_DAYS` (a year by default) are swept at startup.

## How it works

- **Token format** is `bgs_<uuid>_<secret>`. The id locates the row, the secret is compared against a SHA-256 hash in constant time. Expired and revoked tokens are refused, and a failed token is itself audited as `auth.token` denied.
- **Scopes map to a role ceiling**: `read` → viewer, `write` → editor, `admin` → admin. `effectiveRole` intersects the ceiling with the real board role. Instance-scoped operations additionally require the `admin` scope and refuse board-pinned tokens.
- **The integration permission** is `board_members.may_automate`, checked by `requireAutomationAllowed` for every channel except `web`. Existing memberships kept it when the column arrived; new memberships start without it.
- **Bearer tokens are accepted only on `/api/v1/**` and `/mcp*`.** The internal `/api/**` is cookie-only, which is why user administration and credential management, both internal-only, cannot be reached with a token at all.
- **One route table serves two purposes.** The router dispatches from `v1Routes` and the OpenAPI generator documents it, so they cannot drift. Each entry names its operation, HTTP status, response schema, optional defaults (the ticket list defaults to 100 per page), and whether it is a download.
- **Input assembly**: route defaults, then the query string, then the body, then the path parameters last, so a body can never override the URL. A method that exists on a different path answers 405, an unknown path 404.
- **Idempotency**: the key is stored with a fingerprint of method, path, and input, per principal. A replay returns the stored status and body with `Idempotency-Replayed: true`; the same key with a different request answers 409. Keys are pruned after 24 hours.
- **Rate limiting** is keyed on the token id, falling back to the principal, so one leaked token cannot spend everyone's budget.
- **Audit entries are written by the operation runner**, never by hand. The `changes` allowlist keeps secrets out. Denied and errored calls are recorded with their status.

## Code map

| File | What lives there |
|---|---|
| [server/utils/token.ts](../server/utils/token.ts) | `tokenScopes`, `ceilingFor`, `TOKEN_PREFIX`, `hashToken`, `createApiToken`, `resolveToken`, `tokenExpired`, `revokeApiToken`. |
| [server/operations/credentials.ts](../server/operations/credentials.ts) | `service.list`, `service.create`, `service.update`, `service.setStatus`, `service.delete` (instance admin); `token.list`, `token.create`, `token.revoke` (authenticated, own tokens). |
| [server/utils/access.ts](../server/utils/access.ts) | `effectiveRole`, `requireAutomationAllowed`, `requireInstanceAdmin`. |
| [server/middleware/auth.ts](../server/middleware/auth.ts) | `acceptsBearer`, the bearer path, the `auth.token` denial audit. |
| [server/api/v1/routes.ts](../server/api/v1/routes.ts) | `v1Routes`, `compiledRoutes`, `matchRoute`. |
| [server/api/v1/[...path].ts](../server/api/v1/[...path].ts) | The dispatcher: rate limit, route match, input assembly, idempotency replay, download handling, problem responses. |
| [server/utils/openapi.ts](../server/utils/openapi.ts), [docs-page.ts](../server/utils/docs-page.ts) | The OpenAPI document and the HTML reference. |
| [server/utils/problem.ts](../server/utils/problem.ts) | `application/problem+json` shapes and their `type` values. |
| [server/utils/rate-limit.ts](../server/utils/rate-limit.ts) | `checkRateLimit`, `rateLimitMax`. |
| [server/utils/audit.ts](../server/utils/audit.ts) | `writeAudit`, `listAudit`, `pruneAudit`, `auditRetentionDays`. Table `audit_log`. |
| [server/operations/board-domain.ts](../server/operations/board-domain.ts) | `audit.list` (board admin). |
| [server/operations/run.ts](../server/operations/run.ts) | Where every entry is written; `selectChanges` applies the allowlist. |
| [server/plugins/audit-retention.ts](../server/plugins/audit-retention.ts) | The startup sweep of audit entries, idempotency keys, and delivery attempts. |
| [server/utils/db.ts](../server/utils/db.ts) | `ensureActorContext`, `ensureAuditLog`, `ensureServiceIdentities`, `ensureApiTokens`, `ensureIdempotencyKeys`, `ensureBoardMemberAutomation`; `findIdempotent`, `saveIdempotent`, `pruneIdempotent`, `boardAutomationAllowed`. |
| [shared/utils/errors.ts](../shared/utils/errors.ts) | Error shapes shared with the client. |
| `app/components/ApiTokenManager.vue`, `app/pages/profile/integrations.vue` | Minting and revoking tokens; the **What an agent can do** panel. |
| `app/pages/admin/users.vue`, `app/components/AdminAgents.vue` | Agents (service identities), with their tokens and MCP connection. |
| `app/components/BoardMemberSettings.vue` | The Integration checkbox per member. |
| `app/pages/b/[board]/settings/audit.vue` | The audit view. |

## Surfaces

- **Internal routes:** `server/api/tokens/index.get.ts`, `index.post.ts`, `[id].delete.ts`; `server/api/services/index.get.ts`, `index.post.ts`, `[id].patch.ts`, `[id].delete.ts`; `server/api/boards/[id]/audit.get.ts`; `server/api/mcp-info.get.ts`.
- **REST v1:** the full table in `routes.ts`, grouped as workspaces, boards, lanes, members, tickets, attachments, comments, categories and labels, and the imports (`GET`/`POST /boards/{boardId}/import`, TestFlight or Jira by `provider`). Deliberately absent: user administration, tokens, service identities, App Store Connect and Jira credentials, webhooks, and the audit log.
- **MCP:** `whoami` shows the principal, agent label, and scopes behind a token, and whether that principal is a person (`kind: "person"`) or an agent of its own (`kind: "agent"`).
- **Webhooks:** none of the operations here emit events.

## Tests

- `tests/token.test.ts`: agents and service identities (lifecycle, board membership, own tickets and comments), token creation and resolution, the scope ceiling, expiry, revocation.
- `tests/api-v1.test.ts`: the route table invariants, the OpenAPI document, problem documents, rate limiting, cursor paging, idempotency.
- `tests/audit.test.ts`: entries, actor context, denial logging, retention.
- `tests/operations.test.ts`: audit by construction, and that secrets never reach the log.
- `tests/access.test.ts`: the integration permission and the ceiling.

## Configuration

| Variable | Purpose |
|---|---|
| `AUDIT_RETENTION_DAYS` | Days an audit entry is kept; 365 by default, 0 keeps everything. |
| `API_RATE_LIMIT` | Requests per minute per credential on the token surfaces; 120 by default. |
