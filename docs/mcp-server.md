# The MCP server

`/mcp` speaks the Model Context Protocol over Streamable HTTP, authenticated with the same bearer tokens as the REST v1 API. An agent such as Claude, Cursor, or a self-built one can search a board, file tickets, comment, and ask what changed, reaching exactly as far as its token does and recorded under the person or service the token belongs to. This document records how the surface is shaped, the two permission layers a client meets, and what we learned the day a real agent connected.

## Using it

Mint a token under **Your profile → Integrations** (see [api.md](api.md) for scopes, board pinning, and the integration permission), then point the client at the endpoint:

```json
{
  "mcpServers": {
    "open-bugster": {
      "url": "https://bugs.example.com/mcp",
      "headers": { "Authorization": "Bearer bgs_…" }
    }
  }
}
```

The tools are shaped around what somebody actually asks for: searching one board or every reachable one, filing a ticket with its to-do list, commenting, asking `whats_new` for everything that happened on a board since a timestamp, restoring what was archived by mistake, and attaching a file by URL. For that last one the agent hands over a link (a Telegram file URL, say) and the server downloads it itself, so no bytes ever travel through the model's context.

The **What an agent can do** panel under **Your profile → Integrations** lists the tools of the running build. An agent's actions appear in ticket histories and the audit log as *via <agent label>*, beside the person who answers for it.

## The surface: fourteen tools, on purpose

Tool-selection accuracy falls off well before thirty options, so the surface is capped in the
low teens — `tests/mcp.test.ts` enforces `tools.size <= 14`, and the answer to a new need is a
better-shaped tool, not another one. That cap is why to-do lists ride on `create_ticket` /
`update_ticket` (whole-list replace) instead of having tools of their own, and why cross-board
search is `search_tickets` without a `boardId` rather than a second search tool.

| Tool | Does | Annotations |
|---|---|---|
| `whoami` | The principal, agent label, and scopes behind this token | read-only |
| `list_boards` | Boards with lanes and counts, plus the workspaces around them | read-only |
| `board_overview` | One board: lanes, members, labels, categories, its workspace | read-only |
| `search_tickets` | Filtered slim listing; instance-wide when `boardId` is omitted | read-only |
| `get_ticket` | Everything about one ticket, by id or ticket number | read-only |
| `list_lanes` | Just the lanes, when the overview would be overkill | read-only |
| `whats_new` | Board-wide activity since a timestamp — the digest | read-only |
| `create_ticket` | File a ticket, to-dos included | additive |
| `update_ticket` | Change given fields | destructive (overwrites) |
| `move_ticket` | Lane and position | idempotent |
| `comment_on_ticket` | Append to the thread | additive |
| `archive_ticket` | Off the board, reversibly | idempotent, non-destructive |
| `restore_ticket` | The undo of archiving (board admin) | idempotent |
| `add_attachment` | Download a URL server-side and attach it | **open-world** |

Every tool answers with pretty-printed JSON in a single text block — the shape a model reads
best — and errors surface as their message string, so every message in the MCP path is written
for a model's eyes and never carries internals or resolved addresses.

## Two permission layers, and which one enforces

A client meets two independent mechanisms that are easy to conflate:

- **Tool annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
  are *metadata for the client* — self-reported by the server, enforcing nothing. A client's
  approval UX keys off them.
- **Token scopes** (`read` → viewer, `write` → editor, `admin` → admin) are *server-side
  enforcement*. Every call computes an effective role — the principal's own role, capped by
  the scope ceiling (`server/utils/token.ts`, `server/utils/access.ts`) — so a token can never
  exceed the person behind it. The tool list is **not** filtered by scope: a read-only token
  still sees the write tools and gets a plain-worded 403 when it calls one, and `whoami`
  exists so an agent can find out why.

One consequence worth knowing: `restore_ticket` needs board-admin, so a `read · write` token
answers 403 there until it is granted the `admin` scope.

## The finding: unannotated tools read as dangerous (2026-09-01)

The first real agent to connect — Hermes, an agent that happens to speak to its user through
Telegram — refused to run `whats_new` without an explicit write approval. The gating below is
a property of the agent's own MCP client, not of the chat surface in front of it:

```
The user did not approve running write-capable MCP tool 'whats_new' …
```

Two causes stacked, one on each side of the wire:

1. **No tool declared annotations.** The MCP spec's defaults for a bare tool are "assume the
   worst": not read-only, destructive. A cautious client therefore treated the digest — a pure
   read — like a delete. Fixed in v1.1.1: every tool carries honest hints, and a test pins the
   exact read/write/open-world split so no tool ever joins the surface unannotated again.
2. **The client honors hints only from trusted servers — rightly.** Annotations are the
   server's word about itself; a malicious server could label anything read-only. Hermes
   gates them behind a per-server trust tier (`mcp_servers.<name>.trust: full`), and — a
   trap — its only valid values were `full` and `untrusted`, with unknown values (such as
   `trusted`) silently normalized to `untrusted`. Both fixes were needed before the digest
   ran ungated.

The lessons this doc exists to keep:

- **Annotate every tool, always.** Missing metadata is not neutral; the spec reads it as
  dangerous. The split lives in `tests/mcp.test.ts` ("tells clients which tools only read").
- **Be honest, not flattering.** `update_ticket` keeps `destructiveHint: true` because it
  overwrites; `add_attachment` declares `openWorldHint: true` because it is the one tool that
  reaches outside the instance. A client that trusts us should be able to afford to.
- **Expect the client to distrust first.** "It works in `tools/list` but the client still
  gates it" is a client-side trust setting, not a server bug. Checking order: does
  `tools/list` return the annotations (if not: old build)? Did the client reconnect (tool
  metadata is often cached)? Is the server trusted in the client's config?

## The download path of `add_attachment`

Files must never travel through a model's context, so the tool takes a URL and the server
fetches it (`server/utils/attachment-fetch.ts`). The destination is screened exactly like a
webhook target: link-local (cloud metadata) always refused, private ranges governed by
`WEBHOOK_ALLOW_PRIVATE` — permissive by default, since a self-hosted instance often fetches
from its own network. Redirects are refused outright, the body is read with a running 25 MB
cap rather than buffered first, and everything after the download is the ordinary attachment
policy — extension allowlist, magic-byte signatures — shared with `attachment.add`. A URL
without a usable extension (a Telegram file path, say) is named from the response's content
type. The same operation is reachable as `POST /api/v1/tickets/{id}/attachments/from-url`.

## Keeping the panel honest

The **What an agent can do** panel under Profile → Integrations is generated by
`server/api/mcp-info.get.ts`, which registers the real tools against a collector — it cannot
drift from the actual surface. If the panel and this document disagree with a connected
client's view, the client is on an older build or a cached list.

## Code map

| File | What lives there |
|---|---|
| [server/mcp/tools.ts](../server/mcp/tools.ts) | `registerTools`: every tool, its Zod input, its annotations, and the `slim()` projection tickets are listed with. Each tool calls operations through `run()`. |
| [server/routes/mcp.ts](../server/routes/mcp.ts) | The Streamable HTTP transport and the bearer authentication of `/mcp`. |
| [server/api/mcp-info.get.ts](../server/api/mcp-info.get.ts) | The tool list for the profile panel, collected from the real registration. |
| [server/middleware/auth.ts](../server/middleware/auth.ts) | Accepts bearer tokens on `/mcp*`; builds the `Actor` with channel `mcp`. |
| [server/utils/attachment-fetch.ts](../server/utils/attachment-fetch.ts) | The server-side download behind `add_attachment`. |
| `app/components/McpConnection.vue`, `app/pages/profile/integrations.vue` | The connection snippet and the **What an agent can do** panel. |

## Surfaces

Every tool is a thin shape over one or more operations: `whoami` reads the actor; `list_boards` and `board_overview` use `board.list`, `board.get`, `lane.list`, `member.list`, `category.list`, `label.list`; `search_tickets` and `get_ticket` use `ticket.list`, `ticket.get`, `ticket.getByNumber`; `whats_new` uses `board.activity`; the write tools map to `ticket.create`, `ticket.update`, `ticket.move`, `comment.add`, `ticket.archive`, `ticket.restore`, `attachment.addFromUrl`. Because they go through `run()`, every call is audited and fires webhooks like any other.

## Tests

- `tests/mcp.test.ts`: the tool cap, titles and descriptions, the exact read-only and open-world split, the naming rules, and each tool's behaviour against a stub server.
- `tests/token.test.ts`, `tests/access.test.ts`: the scope ceiling the tools inherit.

## Configuration

| Variable | Purpose |
|---|---|
| `WEBHOOK_ALLOW_PRIVATE` | Also governs which URLs `add_attachment` may download from. |
| `API_RATE_LIMIT` | The per-credential budget shared with the REST surface. |
