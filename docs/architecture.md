# Architecture

Open-Bugster is a Nuxt 4 application with an embedded SQLite database. There is no separate backend, no queue, no realtime channel: one Node process serves the browser UI, the REST API, the MCP endpoint, and the webhook dispatcher, all on top of one operation registry. This document describes that shared core. The feature documents build on the vocabulary defined here.

## The shape of it

```
                          server/utils/db.ts            SQLite, migrations, data functions
                                  |
                          server/operations/            the shared core
        one operation = name + Zod input + requirement + audit spec + run(ctx, input)
                                  |
          +-----------------------+-----------------------+
          |                       |                       |
    server/api/**          server/api/v1/**         server/routes/mcp.ts
    session cookie         bearer token             bearer token
    the web UI             REST + OpenAPI           task-shaped agent tools
                                  |
                          server/utils/webhook.ts   signed events to other systems
```

Two rules hold this together, and the tests enforce both:

1. **Nothing mutates data except through an operation.** The operation runner writes the audit entry and fires the webhook, so coverage is structural rather than remembered.
2. **Authorization never reads the transport.** Every guard takes an `Actor`. Each surface builds one its own way, and the access code cannot tell them apart.

## Operations

An operation is declared with `defineOperation` in [server/operations/types.ts](../server/operations/types.ts):

| Field | Meaning |
|---|---|
| `name` | Dotted and stable, e.g. `ticket.move`. It is the audit key, the REST route target, and the MCP tool source at once. Renaming one is a breaking change. |
| `summary` | One line, reused as the OpenAPI summary. |
| `input` | A Zod schema. Validation runs before access resolution, so an operation never sees an unvalidated payload. |
| `requires` | A `Requirement`: `authenticated`, `instance`, `workspace` (+ role), `board` (+ role), `ticket` (+ role), or `comment`. The id functions read the validated input, so an operation cannot check one board and act on another. |
| `audit` | An `AuditSpec` or `false`. `changes` is an **allowlist** of input keys, never the whole input, which keeps passwords, private keys, and invite tokens out of the log by construction. |
| `run(ctx, input)` | The body. `ctx` carries the actor, the resolved role, and the resolved board, workspace, ticket, or comment. |

`run()` in [server/operations/run.ts](../server/operations/run.ts) is the only way to execute one:

```
parse input  →  resolveAccess  →  operation.run  →  record (audit)  →  announce (webhook)
```

Refusals are recorded too, with status `denied`, because somebody probing for boards they cannot see is exactly what an audit trail is for. `audit: false` skips only *successful* reads. `resolveAccess` maps each scope to a guard in [server/utils/access.ts](../server/utils/access.ts); the ticket scope derives the board from the ticket, the comment scope resolves comment → ticket → board.

The registry in [server/operations/index.ts](../server/operations/index.ts) is a `Map` built from the exports of every operation module. `findOperation(name)` is what the REST dispatcher and the MCP tools use.

### The operation modules

| File | Operations |
|---|---|
| [accounts.ts](../server/operations/accounts.ts) | `user.list`, `user.create`, `user.update`, `user.delete`, `user.anonymize`, `user.invite`, `user.revokeInvite`, `profile.update`, `profile.changePassword` |
| [attachments.ts](../server/operations/attachments.ts) | `attachment.get`, `attachment.add`, `attachment.addFromUrl` |
| [board-domain.ts](../server/operations/board-domain.ts) | `board.list`, `board.get`, `board.create`, `board.update`, `board.move`, `board.duplicate`, `board.delete`, `board.setKey`, `board.clearKey`, `board.testConnection`, `lane.list`, `lane.create`, `lane.update`, `lane.reorder`, `lane.delete`, `member.list`, `member.candidates`, `member.set`, `member.remove`, `comment.list`, `comment.add`, `comment.update`, `comment.remove`, `category.list`, `category.update`, `category.delete`, `label.list`, `import.run`, `import.status`, `audit.list` |
| [credentials.ts](../server/operations/credentials.ts) | `service.list`, `service.create`, `service.setStatus`, `token.list`, `token.create`, `token.revoke` |
| [tickets.ts](../server/operations/tickets.ts) | `ticket.list`, `ticket.get`, `ticket.getByNumber`, `ticket.activity`, `board.activity`, `ticket.create`, `ticket.update`, `ticket.move`, `ticket.archive`, `ticket.restore` |
| [ticket-types.ts](../server/operations/ticket-types.ts) | `ticket.type.list`, `ticket.type.create`, `ticket.type.update`, `ticket.type.delete`, `ticket.type.reorder` |
| [webhooks.ts](../server/operations/webhooks.ts) | `webhook.list`, `webhook.create`, `webhook.update`, `webhook.delete`, `webhook.deliveries` |
| [workspaces.ts](../server/operations/workspaces.ts) | `workspace.list`, `workspace.create`, `workspace.update`, `workspace.delete`, `workspace.reorderBoards`, `workspace.member.set`, `workspace.member.remove`, `workspace.member.candidates` |

An operation whose name ends in `.list`, `.get…`, `.activity`, `.status`, `.candidates`, or `.deliveries` may declare `audit: false`. Any other name must carry an audit spec; a test enforces this, so the naming convention is the mechanism.

## The actor

[server/utils/actor.ts](../server/utils/actor.ts) defines `Actor`, the one thing every permission check reads:

| Field | Meaning |
|---|---|
| `principalId`, `principal` | Who answers for the action. The only thing permissions look at. |
| `agentId` | What performed it: a token's agent label such as "Claude Desktop". Provenance, never permission. Null in the browser. |
| `tokenId` | Which credential, so one leaked token can be revoked alone. |
| `channel` | `web`, `api`, or `mcp`. |
| `scopes` | What the credential permits: a **ceiling** on the principal's own role, never a grant. Null for a browser session. |
| `boardScope` | A token pinned to one board, or null. |

`sessionActor(event)` returns the actor the auth middleware already built, so a token never loses its ceiling on the way into an operation. `actorFor(principal, …)` builds one for work with no request behind it.

## Access rules

[server/utils/access.ts](../server/utils/access.ts) holds the guards. The rules that matter:

- **Roles rank.** Board: `viewer < editor < admin`. Workspace: `member < admin`. Instance: `member`, `admin`, `owner`; `owner` and `admin` count as instance administrators and reach every workspace and board.
- **A token is a ceiling.** `effectiveRole` intersects the held board role with `ceilingFor(scopes)`: `read` → viewer, `write` → editor, `admin` → admin.
- **404, not 403.** An unknown board, a board the caller cannot see, and a board outside a token's `boardScope` all answer 404, so nobody can probe for what exists. An archived ticket is a 404 for anyone below board admin.
- **Integration permission.** `requireAutomationAllowed` refuses a non-`web` channel on a board unless the membership carries `may_automate`; instance and board administrators are exempt. See [api.md](api.md).
- **Workspace visibility is derived**: an explicit membership, or membership of any board inside it, or instance admin. Board-pinned tokens are refused on workspace operations outright.
- **Comments** may be edited by their author or a board administrator.

How a request becomes an actor lives in [server/middleware/auth.ts](../server/middleware/auth.ts): bearer tokens are accepted only on `/api/v1/**` and `/mcp*`; the internal `/api/**` is cookie-only. A failed token is audited as `auth.token` denied. A cookie session is re-checked against the account's `sessionVersion` on every request, which is how a password change or a disable ends other sessions.

## Data layer

[server/utils/db.ts](../server/utils/db.ts) is one large module: the schema, the migrations, and every data function. `getDb()` opens the SQLite file at `DATABASE_PATH` with WAL, foreign keys, and a busy timeout, executes the base schema, then runs the ordered migration chain.

**Tables.** Base schema: `boards`, `lanes`, `categories`, `tickets`, `labels`, `ticket_labels`, `ticket_todos`, `apple_feedback`, `attachments`, `users`, `board_members`, `ticket_comments`, `ticket_activity`, `sync_runs`. Added by migrations: `audit_log`, `api_tokens`, `idempotency_keys`, `workspaces`, `workspace_members`, `ticket_types`, `webhooks`, `webhook_deliveries`, `board_integrations` (one row per board and import provider, holding the non-secret settings as JSON and the sealed secret; it replaced the `asc_*` columns on `boards`), `jira_issues`, and `sync_runs.provider`.

**Migrations** are `ensure*` functions, each idempotent, each sniffing the schema (`tableColumns`) before it changes anything, called in a fixed order inside `getDb()`. The order matters and is commented in the file: for example `ensurePersonIdentity` is the last migration that speaks email addresses, and everything after it speaks person ids. Several migrations rebuild tables rather than add columns, which is why they only run forward; see [backups-and-updates.md](backups-and-updates.md).

**Data functions** are grouped by family, in this order in the file: people and identity, migrations, idempotency, membership and workspaces, boards, lanes, tickets (read), categories, ticket types, labels, ticket mutation (`createTicket`, `updateTicket`, `moveTicket`, `archiveTicket`, `restoreTicket`, each taking an optional `Actor` for activity attribution), sync runs, attachments, users and accounts, board members, comments, activity.

**Identity by reference.** People are stored by id, and a ticket's author, assignee, or tester is matched to an account by email address when a page is rendered, not when the row is written. That is what lets a tester who gets an account a month later appear by name on every past report, and what lets anonymizing an account erase the person without rewriting a single history row. See [users-and-access.md](users-and-access.md).

## Shared types and schemas

- [shared/types/domain.ts](../shared/types/domain.ts) holds the domain types the server and the browser share.
- [shared/schemas/domain.ts](../shared/schemas/domain.ts) holds their Zod twins. A `SchemasMatchDomain` tuple at the bottom makes a schema that drifts from its type a compile error, and the `named` map registers the schemas that the OpenAPI document publishes under a stable `$ref` name.
- [shared/utils/constants.ts](../shared/utils/constants.ts), [errors.ts](../shared/utils/errors.ts), and [webhook-catalogue.ts](../shared/utils/webhook-catalogue.ts) hold limits, error shapes, and the webhook event catalogue the UI renders.
- [server/utils/validation.ts](../server/utils/validation.ts) holds the input schemas the operations use.

## The three surfaces

| Surface | Entry | Credential | Notes |
|---|---|---|---|
| Web UI | `server/api/**` | session cookie | Thin handlers of the form `run(op, sessionActor(event), input)`. |
| REST v1 | [server/api/v1/routes.ts](../server/api/v1/routes.ts), dispatched by [server/api/v1/[...path].ts](../server/api/v1/[...path].ts) | bearer token | One declarative route table, from which both the router and the OpenAPI document are generated. See [api.md](api.md). |
| MCP | [server/routes/mcp.ts](../server/routes/mcp.ts), tools in [server/mcp/tools.ts](../server/mcp/tools.ts) | bearer token | Task-shaped tools, capped in the low teens, each calling operations through `run()`. See [mcp-server.md](mcp-server.md). |

Outgoing webhooks are the fourth edge: [server/utils/webhook.ts](../server/utils/webhook.ts) maps operation names to events in `eventForOperation`, and `run()` announces after a successful mutation. See [webhooks.md](webhooks.md).

## Frontend

The app lives under `app/` and uses the internal `server/api/**` routes only.

| Area | Files |
|---|---|
| State | `app/composables/useAuth.ts` (session user), `useBoards.ts` (board list, current board, last board cookie, `useCanAutomate`), `useWorkspaces.ts` (the same for workspaces), `useNotify.ts` (toasts), `useTheme.ts` (light/dark). |
| Middleware | `app/middleware/auth.global.ts` (redirect to `/login`), `board.ts` and `workspace.ts` (resolve the route parameter or 404), `home-board.ts` (send `/` to the last used board inside the selected workspace). |
| Pages | `app/pages/b/[board]/index.vue` (the board), `archive.vue`, `settings.vue` with children `board`, `users`, `integration`, `automation`, `audit`; `app/pages/w/[workspace]/settings.vue`; `app/pages/profile/*`; `app/pages/admin/users.vue`; `login.vue`, `invite/[token].vue`. |
| Key components | `KanbanBoard.vue` (lanes and drag-and-drop), `TicketCard.vue`, `TicketEditor.vue` (the ticket dialog), `TicketComments.vue`, `TicketActivity.vue`, `AppHeader.vue` (switchers, search, menus), `BoardFilterPane.vue`, the `Board*Settings.vue` panels, `ApiTokenManager.vue`, `McpConnection.vue`, `WebhookEventPicker.vue`, `WebhookReference.vue`, and the `Ui*` primitives built on reka-ui. |

Styling is Tailwind 4 with the tokens in `app/assets/css/main.css`. Icons come from `@lucide/vue`.

## Server plugins and utilities

| File | Role |
|---|---|
| `server/plugins/00-runtime-secrets.ts` | Generates and loads `secrets.json` before anything else needs a secret. |
| `server/plugins/session.ts` | Session wiring for `nuxt-auth-utils`. |
| `server/plugins/audit-retention.ts` | Startup sweep: expired idempotency keys, old webhook delivery attempts, audit entries past `AUDIT_RETENTION_DAYS`. |
| `server/middleware/security.ts` | Security headers. |
| `server/utils/problem.ts` | `application/problem+json` errors with stable `type` values. |
| `server/utils/rate-limit.ts` | Per-credential rate limiting for the token surfaces. |
| `server/utils/openapi.ts`, `docs-page.ts` | The OpenAPI 3.1 document and the browsable reference. |
| `server/utils/config.ts` | The bootstrap environment variables. |

## Tests

`npm test` runs vitest over `tests/*.test.ts`. Most tests run against a throwaway SQLite database. The ones that guard architectural invariants:

| Test | Guards |
|---|---|
| `tests/operations.test.ts` | Unique dotted names; validation runs before access; every mutating operation carries an audit spec (the naming rule above); invite tokens, passwords, and attachment bytes never reach the log. |
| `tests/api-v1.test.ts` | Every route points at a registered operation; path parameters exist in the operation's schema; one route per method and path; instance administration stays off the public surface; the OpenAPI document describes exactly the table and every `$ref` resolves. |
| `tests/mcp.test.ts` | The tool count stays between 8 and 14; every tool has a title and a real description; `readOnlyHint` sits on exactly the reads and `openWorldHint` only on `add_attachment`; no tool is named after an operation or mentions tokens, users, services, or keys. |
| `tests/webhook.test.ts` | The shared event catalogue matches the server's event list. |
| `tests/access.test.ts`, `tests/token.test.ts` | Role ranking and the scope ceiling. |
| `tests/person-identity.test.ts` | The email-to-person migration against a legacy database snapshot. |

The per-feature documents list the tests that cover each feature.
