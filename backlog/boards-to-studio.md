# From bug boards to a content production studio

*Architecture proposal · 2026-08-31 · based on the codebase as of commit `672a08f`*

Five ideas — workspaces, custom fields, ticket types, templates, and cross-board jobs — sorted into a dependency-ordered build sequence, with the concept-model decisions to settle first.

## Where the app stands

Open-Bugster is a Nuxt 4 app with an embedded SQLite database (no external backend). The hierarchy is flat and two levels deep: **boards → lanes → tickets**, with categories, labels, and members hanging off each board. Three properties of the codebase shape everything below:

- **One operation registry serves three surfaces.** Every mutation is an operation (`ticket.create`, `lane.delete`, …) consumed by the web UI, the public REST v1 API, and the MCP agent tools. A new concept lands in all three at once — and its access scope, audit spec, and Zod schema are enforced by compile-time and test-time guards. Features can't be landed halfway, which is a good thing.
- **The import lane is a proven pattern.** A flagged, seeded, undeletable lane enforced in the data layer, excluded from defaults, hidden when empty. The template lane idea maps onto it almost one-to-one.
- **There is no realtime.** Clients fetch on navigation; nothing pushes cross-board changes. That constrains how live a cross-board job view can feel (pull/refresh, which is fine for v1).

## The target picture

```
Workspace                        (new — owns everything shared across boards)
├── Boards                       (unchanged: lanes → tickets, members, categories, labels)
│   └── Tickets                  (+ type, + custom field values, + job reference)
├── Ticket types                 (new — "Email", "Social post", "Digital sales aid", each with its field set)
├── Custom field definitions     (new — reusable across types and boards)
├── Templates                    (new — prefab tickets of a type, surfaced as a protected template lane)
└── Jobs                         (new — "Field force launch campaign", bundles tickets across boards)
```

The load-bearing decision: **everything shareable lives on the workspace, not the board.** Types, field definitions, templates, and jobs all need to reach across boards, so the workspace must exist before any of them — which fixes the build order.

## Build sequence at a glance

| Phase | Deliverable | Depends on | Size |
|---|---|---|---|
| 1 | Workspaces — the hierarchy level and its permissions | — | L |
| 2 | Custom fields — definitions engine + values on tickets | 1 | M |
| 3 | Ticket types — identity + field sets, visible on cards | 2 | M |
| 4 | Templates — prefabs + the protected template lane | 3 | S–M |
| 5 | Jobs — cross-board bundles with an aggregate view | 1 (richer after 3) | L |

> **Alternative worth discussing:** custom fields *could* ship first, board-scoped, for quicker visible value — but every definition would need re-scoping to workspaces later, and "the same brief field on three boards" is precisely the problem this direction is trying to solve. Recommendation: eat the foundation cost first.

## Phase 1 — Workspaces (size L)

**Goal:** a workspace groups boards and becomes the owner of everything shared. A migration creates one default workspace and adopts all existing boards, so nothing visibly changes on upgrade day.

```
workspaces        id, name, position, created_at
boards            + workspace_id → workspaces (per-workspace position)
workspace_members workspace_id, user_id, role CHECK ('admin','member')
```

**Main touchpoints:** a new `workspace` access scope in the operation runner (the single clean insertion point — it propagates to web, REST, and MCP at once); `board.create` moves from instance-admin to workspace-admin; the board switcher groups by workspace; the board-list payload gets a lighter shape, since it currently hydrates every board's lanes, members, and counts on each page load and workspaces will multiply board count.

> **For discussion:**
> - **How heavy should workspace membership be?** Option A: workspaces are pure grouping — board membership stays the only real access control, workspace admins just manage the container. Option B: workspace membership grants baseline access to all its boards. A starts smaller and can grow into B; recommended.
> - **URLs:** board IDs are globally unique, so `/b/[board]` can stay as-is with the workspace as context — much cheaper than restructuring to `/w/[ws]/b/[board]`. Recommended: keep the URLs.

## Phase 2 — Custom fields (size M)

**Goal:** workspace-level field definitions and a values store on tickets. This is the engine that types and templates run on.

```
field_definitions   id, workspace_id, label, kind CHECK ('text','number',
                    'select','multiselect','date','checkbox','url'),
                    options JSON, position, archived_at
ticket_field_values ticket_id, field_id, value JSON  (PK ticket_id+field_id)
```

**Main touchpoints:** values validated against their definition at the operation layer (the existing Zod pipeline); ticket hydration and the ticket editor grow a dynamic fields section; fields are exposed through REST and MCP so agents can read and write them. Definitions are archived, never deleted, so historical tickets keep their data.

> **For discussion:**
> - **What attaches fields to a ticket?** Cleanest answer: the ticket's *type* (Phase 3) carries the field set. To make Phase 2 testable standalone, a small interim: a per-workspace "default fields" set shown on every ticket. Alternatively, merge Phases 2+3 into one release.
> - **Filtering/searching by field values:** in v1 or later? (Later keeps Phase 2 at size M.)

## Phase 3 — Ticket types (size M)

**Goal:** a type gives a ticket an identity — "Email", "Social post", "Presentation", "Digital sales aid" — and determines which custom fields it carries.

```
ticket_types  id, workspace_id, name, icon, color, position, archived_at
type_fields   type_id, field_id, required, position
tickets       + type_id → ticket_types (nullable — plain bugs stay typeless)
```

**Main touchpoints:** choosing a type in the editor reveals its field set; cards get a type badge; board filters gain a type dimension. Existing tickets stay untyped and behave exactly as today — types are additive.

## Phase 4 — Templates & the template lane (size S–M)

**Goal:** a template is a prefab ticket of a type — default title pattern, description, field values, todo list. "New from template" stamps out a real ticket.

```
ticket_templates  id, workspace_id, type_id, name, title_pattern,
                  description, default_values JSON, todos JSON, position
```

> **For discussion — the one place the original idea bends:** storing templates *as tickets in a per-board lane* (the literal import-lane clone) would board-scope them — the opposite of what a workspace wants, since "2× email for field force" should be stampable on any board. Recommendation: store templates at the workspace level, but **render them as a protected, undeletable "Templates" pseudo-lane on every board** — same UX as the import lane, same protection pattern (the lane-kind flag, excluded from defaults, hidden when empty), but fed from workspace data. You get the intended interaction without fragmenting the data.
>
> Related: are types and templates two concepts or one? Keeping them separate (type = schema, template = prefab, several templates per type) is recommended, but a v1 could merge them if that feels heavy.

## Phase 5 — Jobs (size L)

**Goal:** a job bundles tickets across the workspace's boards. "Field force launch campaign" holds a Digital sales aid ticket, 2× field-force email, 2× marketing-automation email — each living on its own board, aggregated in one job view with progress at a glance.

```
jobs     id, workspace_id, name, description, status, due_date,
         position, created_at, archived_at
tickets  + job_id → jobs (nullable)
```

**Main touchpoints:** a job view page (grouped by ticket, showing home board and lane as status); a job picker in the ticket editor; job progress derived from lane positions. This phase is last because it crosses every single-board assumption in the platform: the operation context, audit log, and webhook dispatch all assume exactly one board per action, and API tokens can currently be pinned to at most one board (a job-savvy agent wants a workspace-scoped token). Each of those needs a deliberate extension.

> **For discussion:**
> - **One job per ticket, or many?** A single nullable `job_id` is far simpler and matches the campaign use case; a join table can come later if ever needed. Recommended: one.
> - **Visibility:** what does someone see in a job view when it includes tickets from a board they're not a member of? Options: hide those tickets (consistent with today's 404-on-no-membership rule) or show a redacted stub ("1 ticket on Board X"). Recommended: hide, revisit with Phase 1's Option B.
> - **Live-ness:** with no realtime channel, the job view updates on navigation/refresh. Acceptable for v1, or is this the moment to add SSE?

## Cross-cutting rules every phase must respect

- **Migrations are ordered, idempotent functions** appended to the existing chain — each phase adds its own, and the default-workspace adoption in Phase 1 is the only one that touches existing rows.
- **Every new domain type needs its Zod twin** (compile-enforced) and **every new mutating operation needs an audit spec** (test-enforced). Budget for this in every estimate above.
- **Ticket numbers stay instance-global.** That's an asset for jobs — a number is a handle that works across boards — so don't move numbering to per-workspace.
- **Everything ships to three surfaces.** When a phase lands, decide explicitly what the REST v1 API and the MCP tools expose — an agent that can stamp a job's tickets from templates is half the value of this whole direction.

## Open questions, collected

1. Workspace membership: pure grouping (A) or access-granting (B)?
2. Keep `/b/[board]` URLs, workspace as context only?
3. Ship Phases 2 and 3 as one release, or use an interim "default fields" set?
4. Types and templates: two concepts (recommended) or merged for v1?
5. Template lane as workspace-fed pseudo-lane — does that match the intended UX?
6. One job per ticket (recommended) or many?
7. Job view and boards you can't see: hide or stub?
8. Is pull-to-refresh acceptable for the job view, or does Phase 5 trigger realtime?

*Sizes are relative (S < M < L), not calendar estimates.*
