# Phase 1 — Workspaces: implementation plan

*2026-08-31 · follows [boards-to-studio.md](./boards-to-studio.md) · based on the codebase as of commit `672a08f`*

## Decisions this plan adopts

- **Workspaces are grouping, not access control (Option A).** Board membership stays the only thing that grants board access. A workspace admin manages the container: rename, board order, members-of-the-workspace, creating boards. Forward-compatible with Option B later.
- **URLs stay `/b/[board]`.** Board IDs are globally unique; the workspace is context, not a path segment. Workspace settings get their own small route (`/w/[workspace]/settings`).
- **The workspace selector lives in the top bar, right next to the logo**, with a settings cog beside it that only appears for people who may manage the current workspace. The selector follows the `BoardSwitcher` `hasChoice` pattern: with a single workspace it renders nothing at all — so the day the migration runs, the UI looks exactly as before.
- **Visibility is derived.** A user sees a workspace if they are a member of at least one of its boards, hold an explicit workspace membership, or are an instance admin. No backfill of membership rows is needed on migration.

## Step 1 — Schema and migration (`server/utils/db.ts`)

New DDL in the schema literal, plus a new ordered migration.

```sql
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  added_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
-- boards: + workspace_id TEXT NOT NULL REFERENCES workspaces(id)
```

- **`ensureWorkspaces(db)`** in the established idempotent style (sniff `tableColumns(db, 'boards')` for `workspace_id`): create the two tables, add the column, insert one default workspace (name: **"Main"**, position 0), adopt every existing board into it. Positions are untouched — one workspace means the global ordering is already the per-workspace ordering.
- **Slot in the ordered list at `db.ts:242-282`:** after `ensureBoardMemberAutomation(database)` (`:278`), before the `boardIndexes` exec (`:279`).
- **Indexes** (append to the `boardIndexes` literal at `:177`): `idx_boards_workspace ON boards(workspace_id)`, `idx_workspace_members_user ON workspace_members(user_id)`.
- **Data-layer functions** (mirror the board family at `db.ts:1592-1745`): `createWorkspace`, `listWorkspaces(viewer)` (visibility rule above, `ORDER BY position, created_at`), `findWorkspace`, `updateWorkspace` (name), `deleteWorkspace`, `workspaceRoleFor(workspaceId, userId)`, `workspaceMembers`, `setWorkspaceMember` / `removeWorkspaceMember`.
- **Guards, mirroring the board rules:** a workspace that still holds boards cannot be deleted (409); the last workspace cannot be deleted (mirrors "the last board can't be deleted", `board-domain.ts:84`).
- **`createBoard` (`db.ts:1701`)** gains a `workspaceId` parameter; the `MAX(position)` query becomes `WHERE workspace_id = ?`. `listBoards` (`:1661`) keeps returning **all** accessible boards across workspaces — the client groups; the summary just gains `workspaceId`. (Payload-weight optimization is deferred; see "Deferred".)

## Step 2 — Shared types and schemas

- `shared/types/domain.ts`: `WorkspaceRole = 'admin' | 'member'`; `Workspace { id, name, position, createdAt }`; `WorkspaceSummary extends Workspace { members: WorkspaceMember[], boardCount: number, role: WorkspaceRole | null }` (`role` = the caller's own, `'admin'` implied for instance admins, `null` = visible only via board membership); `Board`/`BoardSummary` gain `workspaceId`.
- `shared/schemas/domain.ts`: Zod twins for each, entries in the `SchemasMatchDomain` tuple (`:240-262`), and registration in the `named` map (`:222`) so v1 OpenAPI gets `$ref`s. The compile guard makes forgetting any of this an error.

## Step 3 — Access layer and operations

- **`server/operations/types.ts`** — extend the `Requirement` union (`:13-18`):
  ```ts
  | { scope: 'workspace'; role?: WorkspaceRole; workspaceId: (input: I) => string }
  ```
  and add `workspaceId: string | null` to `OperationContext`.
- **`server/utils/access.ts`** — new `requireWorkspaceAccess(actor, workspaceId, minimum = 'member')`, shaped like `requireBoardAccess` (`:84-98`): unknown or invisible workspace → **404** (same no-probing rule); instance admin → implicit `admin`; visible-but-too-low → 403. Board-pinned tokens (`actor.boardScope`) are refused with 404 — a credential pinned to one board has no business managing containers, consistent with `requireInstanceAdmin` (`:27`). Token scope ceiling applies as elsewhere: workspace-admin operations require an `admin`-scoped token.
- **`server/operations/run.ts`** — new `case 'workspace'` in `resolveAccess` (`:51-82`) returning `{ ...base, workspaceId }`. No `audit_log` schema change: workspace operations audit with `targetType: 'workspace'` and a null `board_id`.
- **New `server/operations/workspaces.ts`**, registered in `operations/index.ts:27`:

  | Operation | Requires | Audit |
  |---|---|---|
  | `workspace.list` | `authenticated` | none (matches the read-verb regex) |
  | `workspace.create` | `instance` | `targetType: 'workspace'`, changes: name |
  | `workspace.update` | `workspace` / `admin` | changes: name |
  | `workspace.delete` | `instance` | yes (refuses while boards remain) |
  | `workspace.member.set` | `workspace` / `admin` | yes |
  | `workspace.member.remove` | `workspace` / `admin` | yes (a workspace keeps ≥1 admin, mirroring `memberRemove`) |
  | `workspace.member.candidates` | `workspace` / `admin` | none |

- **`board.create` (`board-domain.ts:54-61`)** changes requirement from `{ scope: 'instance' }` to `{ scope: 'workspace', role: 'admin', workspaceId: input => input.workspaceId }`, and its input schema gains `workspaceId`. Instance admins pass automatically through the implicit-admin rule, so nothing is taken away.

## Step 4 — API surfaces

- **Internal (`server/api/`)** — thin three-line wrappers as everywhere: `workspaces/index.get.ts`, `index.post.ts`, `[id].patch.ts`, `[id].delete.ts`, `[id]/members/[userId].put.ts` + `.delete.ts`, `[id]/members/candidates.get.ts`. `boards/index.post.ts` body now carries `workspaceId`.
- **Public v1 (`server/api/v1/routes.ts`)** — additive only: `GET /workspaces` (list), `workspaceId` on board payloads, and `workspaceId` required in `POST /boards`. Workspace management (create/update/members) stays **internal-only** for now, same reasoning as user administration being deliberately absent from v1 (`routes.ts:36-38`). Revisit when workspace-scoped tokens arrive with jobs.
- **MCP (`server/mcp/tools.ts`)** — add `workspaceId`/workspace name to the board projections so agents can tell boards apart; no dedicated workspace tool yet.
- **Webhooks** — untouched; they are board-scoped and workspace operations emit no events in v1.

## Step 5 — Frontend state (`app/composables/`)

- **New `useWorkspaces.ts`**, mirroring `useBoards.ts` exactly: `useState<WorkspaceSummary[]>('workspaces')` with the same owner-key cache discipline (`'workspaces-loaded-for'`), `loadWorkspaces(force)`, `clearWorkspaces()` from logout.
- **`useCurrentWorkspaceId()`** — a cookie `open-bugster-workspace` (precedent: `open-bugster-board`, `useBoards.ts:61`), plus the rule that **the current board's `workspaceId` always wins** when on a board page. The board page's existing `watchEffect` that records the last board also records its workspace, so switcher and reality can't drift.
- Because `listBoards` still returns all boards, the board cache key needs no workspace component — no stale-on-switch problem.
- **Middleware:**
  - `home-board.ts` becomes workspace-aware: resolve the target inside the selected workspace first — last-visited board if it belongs to it, else the workspace's first board, else fall through to any board (covers a stale workspace cookie).
  - `board.ts` needs no structural change (board lookup is by globally unique ID); its fallback `boards[0]` becomes "first board of the current workspace, else any".
  - An **empty workspace** resolves to `/` rendering a small empty state: "No boards yet" plus a create-board button for workspace admins.

## Step 6 — Header UI (the part you sketched)

**New `WorkspaceSwitcher.vue`**, mounted in `AppHeader.vue` directly after the logo link (`:37`). The logo's `mr-auto` moves onto the switcher's wrapper so it hugs the logo and everything else stays right-aligned. Since `AppHeader` also renders on board-less pages (`/profile`, `/admin/users`), the switcher reads `useWorkspaces()` itself rather than taking props, with the same load-before-render discipline `loadBoards()` uses.

Behavior, mirroring `BoardSwitcher`:

- `hasChoice = workspaces.length > 1`. One workspace → render **nothing** (not even a static label — the header stays exactly as today). Two or more → a subtle divider after the logo, then a `DropdownMenuRoot` trigger showing the current workspace name + chevron.
- Menu items: workspace name, board count on the right, check on the current one. Selecting writes the `open-bugster-workspace` cookie and navigates to `/` — `home-board.ts` then lands on the right board (or the empty state).
- **Settings cog right next to the trigger**, shown when the caller's role on the *current* workspace is `admin` (explicit or instance-admin-implied) → `/w/[workspace]/settings`. Same `focus-ring` icon-button styling as the header's theme toggle.
- Menu footer: "New workspace" item, `v-if="instanceAdmin"` (workspace creation stays instance-level), opening a create dialog copied from `BoardSwitcher.vue:165-198`, then `refreshWorkspaces()` → set cookie → `navigateTo('/w/{id}/settings')` — same refresh-before-navigate ordering the board create flow documents.

**Entry point when the selector is hidden:** an avatar-menu item "Workspaces" for instance admins (next to "Users", `AppHeader.vue:73-79`) → workspace settings of the current workspace. That is where the *second* workspace gets created, after which the selector appears on its own.

**New pages `app/pages/w/[workspace]/settings.vue`** (+ children), modeled on the board settings shell (`app/pages/b/[board]/settings.vue`) and the admin gating pattern (`admin/users.vue:5-9`: client-side `watchEffect` bounce, real enforcement server-side):

- **General** — rename; danger zone with delete (disabled while boards remain, with the count as explanation).
- **Boards** — list, drag order (writes per-workspace positions), "New board" (this becomes the canonical creation spot; the `BoardSwitcher`'s "+ new board" is re-gated from `instanceAdmin` to workspace-admin-of-current and passes `workspaceId`).
- **Members** — workspace admins/members, add from candidates, remove; mirrors `BoardMemberSettings.vue` in miniature.

**`BoardSwitcher`** — one change: the parent passes `boards` filtered to the current workspace, so the board dropdown never mixes workspaces.

## Step 7 — Tests

- `tests/db.test.ts` — migration coverage: a pre-workspace database gets exactly one "Main" workspace, all boards adopted, positions preserved; re-running is a no-op.
- `tests/access.test.ts` — a `requireWorkspaceAccess` suite: invisible workspace → 404; member-of-one-board sees the workspace but gets 403 on admin ops; instance admin implicit; board-pinned token → 404; token scope ceiling narrows, never widens.
- `tests/operations.test.ts` — the registry-shape and audit-by-construction suites pick the new operations up automatically; verify `workspace.list`/`…candidates` pass the read-verb regex and everything else carries an audit spec.
- `tests/lanes.test.ts` — `createBoard` fixture signature updates; new case: board position scoped per workspace.
- `tests/api-v1.test.ts` — route table + OpenAPI document additions.
- `tests/mcp.test.ts` — board projections now carrying `workspaceId`.
- `tests/audit.test.ts` — workspace ops write rows with `targetType: 'workspace'` and null `board_id`.

## Rollout

Upgrade day is deliberately invisible: the migration creates "Main", adopts every board, the selector renders nothing for a single workspace, all URLs and cookies keep working, and `board.create` still works for instance admins (implicit workspace admin). The feature only becomes visible when an instance admin creates a second workspace from the avatar menu.

Suggested merge order (each lands green on its own): **1+2** (schema, types — inert), **3+4+7** (access, operations, APIs, tests), **5+6** (state, header, settings pages).

## Deferred (explicitly not in Phase 1)

- Moving a board between workspaces (`board.update` + workspace re-position — small follow-up).
- Per-workspace last-board memory (single `open-bugster-board` cookie is enough; switching workspaces lands on its first board).
- Lightening the board-list payload (embedded lanes/members per board) — becomes pressing when workspaces multiply board count, worth doing before Phase 5.
- Workspace management in the public v1 API and workspace-scoped tokens — arrive with jobs (Phase 5).
- Option B semantics (workspace membership granting board access).

## Decisions taken

1. Default workspace name: **"Workspace"**.
2. Workspace creation: **instance admins only**.
3. Selector **fully hidden** while only one workspace exists.

## As built (deviations from the plan above)

Implemented 2026-08-31; all 284 tests green, verified end-to-end in the browser against a
scratch instance and the migration against a copy of the real database.

- **Workspace settings is one page**, `/w/[workspace]/settings`, with stacked sections
  (General, Boards, Members, New workspace, Danger zone) instead of tabbed child pages —
  three small sections did not justify a tab shell. The **New workspace** section (instance
  admins only) lives here because the switcher's own "New workspace…" item only exists once
  there are two; the avatar-menu "Workspaces" item leads here.
- **`workspaceId` on `board.create` is optional**, resolving to the default workspace — the
  requirement resolves it via `defaultWorkspaceId()` — so pre-workspace API clients keep
  working; v1 stays fully additive.
- **No ≥1-admin guard on `workspace.member.remove`**: a workspace with no admins at all is
  the normal state (the migration creates the default one member-less), and instance admins
  hold every workspace regardless — the board-style guard would have been inconsistent.
- **`workspace.reorderBoards`** (internal `PATCH /api/workspaces/{id}/board-order`) reorders
  boards; the settings page shows its up/down controls only when the caller can see the
  workspace's complete board list, since a partial permutation is refused with 422.
- `ensureWorkspaces` also self-heals any board without a workspace on every start, and
  creates its own indexes rather than extending `boardIndexes` (which runs earlier, before
  the column exists on old databases).
- The operation-name test now allows three dotted segments (`workspace.member.set`).
- `.claude/launch.json` gained a `bugster-scratch` configuration: a second dev instance on a
  throwaway database for end-to-end checks without touching `data/real`. A pre-migration
  backup sits at `data/real/bugster.sqlite.before-workspaces.bak`.
