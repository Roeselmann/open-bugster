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

The tools are shaped around what somebody actually asks for: searching one board or every reachable one, filing a ticket with its to-do list, commenting, asking `whats_new` for everything that happened on a board since a timestamp, restoring what was archived by mistake, and attaching a file. A second, smaller group lets an agent with an account of its own organise its boards: open and rename boards, lay out lanes, add people, tidy labels and categories, and keep the workspace's ticket types. For a file online the agent hands over a link (a Telegram file URL, say) and the server downloads it itself; for one on the agent's own disk it asks for a one-time upload address and sends the file there with `curl`. Either way no bytes ever travel through the model's context.

The **What an agent can do** panel under **Your profile → Integrations** lists the tools of the running build. An agent's actions appear in ticket histories and the audit log as *via <agent label>*, beside the person who answers for it.

## The surface: twenty-eight tools, on purpose

Tool-selection accuracy falls off well before thirty options, so the surface is capped:
sixteen tools for tickets and twelve for a board's structure — `tests/mcp.test.ts` enforces
`tools.size <= 28`, and the answer to a new need is a better-shaped tool, not another one. That cap is why to-do lists ride on `create_ticket` /
`update_ticket` (whole-list replace) instead of having tools of their own, and why cross-board
search is `search_tickets` without a `boardId` rather than a second search tool. The one
exception so far is `get_attachment`: returning image content is something no existing tool
could take on without every `get_ticket` call paying for pictures nobody asked to see. The
other is `create_upload_url`: folding it into `add_attachment` would give one tool two
unrelated jobs and two sets of annotations.

| Tool | Does | Annotations |
|---|---|---|
| `whoami` | The principal, agent label, and scopes behind this token; `kind` says whether the principal is a person or the agent itself; `canChangeStructure` whether the token permits the structure tools | read-only |
| `list_boards` | Boards with lanes and counts, plus the workspaces around them, each with `yourRole` | read-only |
| `board_overview` | One board: lanes, members (with `mayAutomate`), labels, categories with their colour, its workspace | read-only |
| `search_tickets` | Filtered slim listing; instance-wide when `boardId` is omitted | read-only |
| `get_ticket` | Everything about one ticket, by id or ticket number | read-only |
| `get_attachment` | Look at an attachment: images as a scaled JPEG, other files as details | read-only |
| `list_lanes` | Just the lanes, when the overview would be overkill | read-only |
| `whats_new` | Board-wide activity since a timestamp — the digest; `structure` lists what was done to the board itself | read-only |
| `create_ticket` | File a ticket, to-dos included, at the top or bottom of its lane; with `parentTicketId` as a subticket of another | additive |
| `update_ticket` | Change given fields | destructive (overwrites) |
| `move_ticket` | Lane and position, or with `boardId` onto another board of the workspace | idempotent |
| `comment_on_ticket` | Append to the thread | additive |
| `archive_ticket` | Off the board, reversibly | idempotent, non-destructive |
| `restore_ticket` | The undo of archiving (board admin) | idempotent |
| `add_attachment` | Download a URL server-side and attach it | **open-world** |
| `create_upload_url` | A one-time address to `curl` a local file to | additive |
| `move_tickets` | Up to 50 tickets of one board into a lane, together and in the given order | idempotent |
| `create_board` | A new board, with its own lanes or the default four; the creator becomes its admin | additive |
| `update_board` | A board's name and description | destructive (overwrites) |
| `delete_board` | A board with no tickets at all, archived ones included | **destructive** |
| `save_lane` | Add a lane, or rename, flag (`isDone`/`isLive`) and place one | destructive (overwrites) |
| `delete_lane` | A lane, its tickets moved to another lane or archived | **destructive** |
| `member_candidates` | Accounts that could still join a board, by name and id | read-only |
| `set_board_member` | Add somebody or change their role and `mayAutomate` | destructive (overwrites) |
| `remove_board_member` | Take somebody off a board | **destructive** |
| `edit_label` | Rename (merging onto an existing name) or delete a label on every ticket | **destructive** |
| `edit_category` | Create, rename or recolour, or delete a category, by name | **destructive** |
| `edit_ticket_type` | Create, rename or recolour, or delete a ticket type of the workspace | **destructive** |

### Subtickets

A to-do can be a ticket of its own, and an agent can follow it both ways without a tool of its own:

- **Which lane finishes a ticket.** Every lane in `list_boards`, `board_overview` and `list_lanes` carries `isDone`. A subticket counts as done once it sits in such a lane of its own board; its `completed` is never set by hand.
- **Down, from the parent.** In `get_ticket`, a to-do with `subticketId` carries `subticket: { number, boardId, board, laneId, lane, archived }`, enough to move it without a second read.
- **Up, from the subticket.** `get_ticket` lists `parents`: the tickets whose lists hold this one, each with its own `progress`. Only parents this token can read appear; others are left out without a trace.
- **Progress at a glance.** `search_tickets` and the replies of the write tools carry `progress: { done, total, light, openSubtickets, subtickets }`, or null without to-dos. `light` is the card's traffic light: `green` when everything is done, `orange` from half, `red` below. The list itself stays in `get_ticket`, so a search stays cheap.
- **The whole plan at once.** `get_ticket` with `timeline: true` adds `timeline: { covers, warnings, subtickets }`: every subticket down through theirs with board, lane, `startDate` and `dueDate`, plus warnings for overdue work and anything outside the ticket's own window. Subtickets on boards the token cannot read carry `readable: false` and nothing below them. `create_ticket` and `update_ticket` take `startDate` beside `dueDate`, and `liveFrom`/`liveUntil` for the days a ticket is out in the world. Both take `schedule` too — `none`, `milestone` (one day, given as `dueDate`, no start, no live window) or `lifecycle` — and tickets and timeline nodes report it; switching clears what the new schedule has no room for, and dates sent to an undated ticket without one make it a lifecycle. Lanes carry `isLive` beside `isDone`: a subticket in a live lane counts as done too. `schedule` may also be `recurring`, with `recurrence` (`frequency`, `interval`, `anchor`, `until`, `resetTodos`, `returnLaneId`): the card comes round again, `dueDate` is the round that is on now, and the server closes each round when the next is due, done or missed. Search results carry `repeats`, `nextRound` and `lastRound` for such a ticket, `get_ticket` its rule and last `rounds`; `update_ticket` with `closeRound: "done" | "skipped"` ends the round at once and `reopenRound: true` undoes the last close while the next round is not yet due, and `whats_new` reports `new_round` and `round_missed`.
- **Dependencies.** `get_ticket` lists `waitsOn` (finish-to-start: the ticket starts once these end) and `waitedOnBy`, each with number, board, lane, `done` and dates; search results carry `waitsOn` as numbers, and so do timeline nodes. The timeline's warnings include tickets starting before what they wait on ends, tickets waiting on something late, and tickets finished while something they wait on is open; `move_ticket` and `move_tickets` put that last one in their reply as `warnings`. `create_ticket` and `update_ticket` take `waitsOn` as the whole list of ticket ids. `update_ticket` with `shift: { days, dryRun }` moves the ticket's start and due date, and everything waiting on it, by the same days, and replies with what moved and what stayed put. Finished work and tickets the token may not edit stay put, and live windows never move. A dry run has to come on its own; the server instructions tell agents to dry-run first. This added no tool.
- **Decisions.** A to-do can carry `decision: { options, multiple, allowOther }`, making its `text` a question for people to settle — which logo, which channels. `get_ticket` shows it with `answer`, `decidedBy` and `decidedAt` once decided. Agents can ask one and read it but not answer it: whatever they send, the result stays what a person decided, and one they add starts open. Sent back through `update_ticket` with the same question and options, it keeps its result.
- **Strict order.** `create_ticket` and `update_ticket` take `strictOrder`, and `get_ticket` reports it. A strict list is worked top to bottom: an update completing a to-do or decision while one above is open is refused, a subticket moved into a done or live lane out of turn is refused the same way, and each subticket waits on the one before it — listed in `waitsOn` with `strictOrderOf` (the parent's number), counted by the timeline and by `shift`. Such entries need not be sent back and cannot be removed on their own.
- **Writing.** `create_ticket` with `parentTicketId` files a new subticket on any board of the workspace; `update_ticket` links an existing ticket by naming its id as `subticketId` in the to-dos, and unlinks one by leaving it out.

### Structure

The twelve tools after `create_upload_url` in the table let an agent organise its boards. All of them but `move_tickets` change a board's shape rather than its tickets, and the server refuses them unless the token carries the `admin` scope **and** the principal is an administrator of the board — or of the workspace, for `create_board` and `edit_ticket_type`. There is no separate structure scope: `admin` is it. `whoami` answers `canChangeStructure` (true for an unrestricted token or one with `admin`) with a sentence saying that the role still applies, and `list_boards` carries `yourRole` per board and per workspace, so an agent can tell where it may act before it tries.

- **Boards.** `create_board` opens a board in a workspace (the default one when `workspaceId` is omitted). Without `lanes` it gets the seeded Import, Backlog, In Progress and Done; with `lanes` exactly those, left to right, in the same transaction as the board — and no import lane; the first TestFlight or Jira import adds one. The creator becomes the board's administrator, so the board turns up in their next `list_boards` even over MCP, where only boards one may automate are listed. It replies with the board as `board_overview` shows it. `update_board` changes the name and description only; the sync settings stay with the UI. `delete_board` deletes only an empty board: the tool always sends `onlyIfEmpty`, and `board.delete` counts the tickets — archived ones too — inside the transaction that deletes, so nothing filed meanwhile is swept away. REST callers that leave the flag out keep the old behaviour.
- **Lanes.** `save_lane` creates a lane without `laneId` and changes one with it; `index` places it (0 is the leftmost) through `lane.reorder`. Done and live exclude each other: switching `isLive` on switches `isDone` off and the other way round, and the import lane is neither. When a change makes a lane's tickets count as finished, or open again, the reply carries a `note` with their number and what follows: subtickets ticked or unticked on their parents, due dates quiet or warning, a recurring ticket's round closing as done or missed. `delete_lane` deletes an empty lane directly; one holding tickets needs `moveTicketsTo` (another lane of the board) or `archiveTickets: true`, and is refused with the ticket count and both options otherwise. The tool's empty case runs `lane.delete` with mode `empty`, which re-counts inside the transaction.
- **People.** `member_candidates` lists who could still join, by name and id and with `isAgent` for agents, never an address. Unless the principal administers the instance, the list holds only accounts it shares a workspace with; `email` with somebody's whole address adds that one account, so an agent can reach a person from outside without being shown everybody. `set_board_member` adds somebody or changes their role and `mayAutomate` — whether that account may work the board through a token. Board administrators and agents always may; an instance administrator is exempt as well. `remove_board_member` takes somebody off; tickets assigned to them keep the assignee. Neither will leave a board without an administrator. An agent on a board by a workspace-wide grant is listed with `through` and cannot be removed there; the refusal says the grant is what to change.
- **Vocabulary.** `edit_label` renames a label on every ticket of the board or deletes it (`label.rename`, `label.delete`). Labels are per board and matched case-insensitively. Renaming onto a name another label already has merges the two: each ticket keeps the one label, once. `edit_category` creates (`category.create`), renames or recolours, or deletes a category by name; the colours are those of `categoryColors`. A deleted category leaves its tickets without one. `edit_ticket_type` creates, renames or recolours, or deletes a type of the workspace; picking an icon other than the default is left to the UI, since the curated set has thirty names.
- **Many tickets at once.** `move_tickets` puts up to 50 tickets of one board into a lane, together and in the given order, the first at `index` among the lane's other tickets. It calls `ticket.move` once per ticket, so each move is audited, announced and in the ticket's history as usual. Each is placed right after the one before, which keeps the order right when some of them already sit in the lane above the insertion point. Everything is checked before the first move; if one fails anyway, the reply lists what moved, the one that failed and why, and the rest as not attempted. Moving between boards stays with `move_ticket`.
- **What changed.** `whats_new` carries `structure` beside `entries`: the board's successful structural operations since `since`, newest first, each with `operation`, `by`, `via`, `at` and `detail` — the fields the operation's audit spec allowlisted, plus the target's current name. It reads `board.structure.list`, which board *viewers* may call: a fixed list of operations (`board.create`, `board.update`, `lane.*`, `member.set`, `member.remove`, `category.*`, `label.*`), successful entries only, and never an IP, token id or refused attempt. `board.create` runs against the workspace, so its row carries no board id; the read matches it by its target instead. It reaches back as far as `AUDIT_RETENTION_DAYS` keeps entries, a year by default. The full log, `audit.list`, stays with board administrators.

### An agent as a user of its own

A token usually acts for a person. It can instead belong to an agent with an account of its own (see [api.md](api.md#agents-service-identities)). Then `whoami` answers `kind: "agent"` with the agent's `description` and a note that the tickets assigned to its `principalId` are its own work, found with `search_tickets` and `assigneeId`. In `board_overview`, such a member carries `isAgent: true`. The server instructions mention both cases, so an agent learns which one it is from its first `whoami`.

The `description` of `create_ticket` and `update_ticket` and the `body` of `comment_on_ticket`
are Markdown; their field descriptions say so, so an agent formats with headings, lists and
fenced code blocks on its own. Raw HTML is escaped when rendered.

Every tool answers with pretty-printed JSON in a single text block — the shape a model reads
best, with one exception: `get_attachment` returns an image block for an image — and errors surface as their message string, so every message in the MCP path is written
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
answers 403 there until it is granted the `admin` scope. The same holds for every structure
tool except `move_tickets`; `whoami` reports it as `canChangeStructure`.

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

## Files on the agent's disk: `create_upload_url`

A file somebody hands an agent in a chat sits on the agent's machine, not at a URL, and
pushing it through the tool call as base64 would cost its whole size in output tokens — and
an image the model only *saw* cannot be reproduced byte for byte anyway. Giving the agent
the API token to `curl` the REST upload itself is out too: the token stays in the client's
MCP configuration, out of the agent's reach, on purpose.

So `create_upload_url` (operation `attachment.uploadUrl`, also `POST
/api/v1/tickets/{id}/attachments/upload-url`) mints an address instead:
`/api/uploads/{secret}`, good for **one file, one ticket and ten minutes**, returned with the
`curl -F 'file=@…'` command that spends it. The address is its own credential, so the auth
middleware lets `/api/uploads/*` through without a token; the secret is 256 random bits and
only its hash is stored (`upload_slots`, `server/utils/upload-slot.ts`).

When the file arrives, the handler (`server/api/uploads/[secret].post.ts`):

1. looks the slot up before reading the body, so a dead address costs no upload — an
   unknown one leaves an `attachment.upload` *denied* entry in the audit log;
2. spends it atomically, so two racing uploads cannot both get through — a rejected file
   costs the agent a new address, never a second try on the same one;
3. rebuilds the actor that asked, through the token it asked with — a token revoked or an
   account disabled in the meantime takes the address down with it;
4. runs the ordinary `attachment.add` as that actor, so access is checked again, the policy
   (allowlist, signatures, 25 MB) applies unchanged, and the audit entry and webhook are the
   usual ones, *via* the agent's label.

Spent and expired slots are swept at startup with the other retention work.

## Looking at attachments: `get_attachment`

`get_ticket` lists attachments with a `/api/v1/attachments/{id}` url, but an agent usually
cannot use it: without the token the url redirects to the login, and the token sits in the
client's MCP configuration, out of the agent's reach. So `get_attachment` returns the file
through the MCP connection itself, taking the `id` each `get_ticket` attachment carries.

An image is scaled to at most `maxDimension` pixels (default 1500) on its longer side and
re-encoded as JPEG by `server/utils/image-preview.ts` (sharp). A TestFlight screenshot of
about 500 KB and 2000 px would otherwise cost far more context than reading it needs. It
comes back as an MCP image block followed by a text block with the details. Any other
file, and an image sharp cannot decode (HEIC), returns only its filename, type and size.
Access runs through `attachment.get`, and a file on a board the token cannot see answers
the same "Attachment not found." as an unknown id.

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
| [server/utils/upload-slot.ts](../server/utils/upload-slot.ts), [server/api/uploads/[secret].post.ts](../server/api/uploads/[secret].post.ts) | The one-time upload addresses behind `create_upload_url`, and where they are spent. |
| [server/utils/image-preview.ts](../server/utils/image-preview.ts) | The scaled JPEG `get_attachment` returns for an image. |
| `app/components/McpConnection.vue`, `app/pages/profile/integrations.vue` | The connection snippet and the **What an agent can do** panel. |

## Surfaces

Every tool is a thin shape over one or more operations: `whoami` reads the actor; `list_boards` and `board_overview` use `board.list`, `board.get`, `lane.list`, `member.list`, `category.list`, `label.list`; `search_tickets` and `get_ticket` use `ticket.list`, `ticket.get`, `ticket.getByNumber`, `ticket.timeline.get`, `ticket.dependents.list`; `get_attachment` uses `attachment.get`; `whats_new` uses `board.activity` and `board.structure.list`; the write tools map to `ticket.create`, `ticket.update`, `ticket.shift`, `ticket.move` (also behind `move_tickets`), `comment.add`, `ticket.archive`, `ticket.restore`, `attachment.addFromUrl`, `attachment.uploadUrl`. The structure tools map to `board.create`, `board.update`, `board.delete` (with `onlyIfEmpty`), `lane.create`, `lane.update`, `lane.reorder`, `lane.delete`, `member.candidates`, `member.set`, `member.remove`, `label.rename`, `label.delete`, `category.create`, `category.update`, `category.delete`, `ticket.type.create`, `ticket.type.update`, `ticket.type.delete`. Every one of them is also a REST v1 route. Because they go through `run()`, every call is audited and fires webhooks like any other.

## Tests

- `tests/mcp.test.ts`: the tool cap, titles and descriptions, the exact read-only and open-world split, the naming rules, and each tool's behaviour against a stub server — for the structure tools also the write-scope refusal, the empty-board and full-lane refusals, the last administrator, the label merge, the order `move_tickets` leaves, and a viewer's `whats_new.structure` without refused attempts.
- `tests/token.test.ts`, `tests/access.test.ts`: the scope ceiling the tools inherit.
- `tests/upload-slot.test.ts`: upload addresses are single-use, expire, die with their token, keep their secret out of the database and the log, and act as the agent that asked.

## Configuration

| Variable | Purpose |
|---|---|
| `WEBHOOK_ALLOW_PRIVATE` | Also governs which URLs `add_attachment` may download from. |
| `API_RATE_LIMIT` | The per-credential budget shared with the REST surface. |
