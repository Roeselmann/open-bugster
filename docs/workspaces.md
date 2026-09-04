# Workspaces

A workspace groups boards: one per team, client, or department. It is a container with its own name, description, board order, and administrators. Membership of a workspace grants nothing on its boards, since each board keeps its own members and roles. Every instance has at least one workspace, and an instance that never touches the feature never sees it.

## Using it

Every instance starts with a single workspace named **Workspace**. As long as it keeps that name and has no description, nothing about workspaces appears anywhere and the app looks as if the level did not exist. Give the lone workspace a name of its own or a description, and its name appears in the header next to the logo as a plain title, with the description beside it.

Two levels are kept apart on purpose:

- **Workspaces** (`/admin/workspaces`), under *Administration* in the account menu next to *Users*, is the instance-level overview for instance administrators: every workspace with its board and member counts, a link into each one's settings, and the form that creates a new workspace. Creating one leads straight into its settings.
- **Workspace settings** (`/w/[workspace]/settings`) is about one workspace only. It is reached from the workspace's context: the settings icon beside the name in the header, the *Settings of …* entry in the switcher menu, and on phones the same entry in the menu sheet. Instance administrators find a link back to the overview at the top.

The moment a second workspace exists, the workspace name in the header becomes a switcher. Instance administrators see the menu even with a single workspace, because it carries the **New workspace…** shortcut and the way to the overview. Switching a workspace lands on its last visited board, or its first, or on an empty state with a create-board button for workspace administrators.

The workspace settings page holds:

- **General**: name and description.
- **Boards**: the list, create new ones, and reorder them; the order is what the board switcher offers.
- **Members**: workspace **administrators** manage the workspace and open boards in it; **members** merely see it listed. Neither role grants access to a board inside it.
- **Danger zone** (instance administrators only). A workspace can be deleted only when it holds no boards, and the last workspace cannot be deleted.

A board can be **moved** to another workspace and **duplicated**, into the same workspace or a different one, from **Board settings → Board**, above the danger zone. Moving keeps everything, members and credentials included, and only changes where the board hangs. Duplicating copies the structure (lanes, categories, labels, members) with an optional **Include tickets** switch; the App Store Connect key, webhooks, comments, and history always stay with the original.

## How it works

- **Visibility is derived, not stored.** A person sees a workspace if they hold an explicit workspace membership, are a member of at least one board inside it, or are an instance administrator. No membership rows are backfilled on migration.
- **Workspaces are grouping, not access control.** Board membership stays the only thing that grants board access. A workspace with no administrators at all is a normal state, because instance administrators hold every workspace regardless.
- **URLs stay `/b/[board]`.** Board ids are globally unique, so the workspace is context rather than a path segment. Only the settings page has a workspace route, `/w/[workspace]/settings`; the overview lives under `/admin/workspaces`.
- **Board creation is a workspace-admin operation.** `board.create` takes an optional `workspaceId` and falls back to the default workspace, so API clients that predate workspaces keep working. Instance administrators pass through the implicit-admin rule.
- **Reordering is all-or-nothing.** `workspace.reorderBoards` refuses with 422 unless the new order lists every board of the workspace exactly once. The settings page therefore shows its reorder controls only to someone who can see the complete board list.
- **Board-pinned tokens** cannot run workspace operations at all; they answer 404.
- **Upgrade is invisible.** The migration creates the default workspace, adopts every board, and self-heals any board without a workspace on every start.

## Code map

| File | What lives there |
|---|---|
| [server/operations/workspaces.ts](../server/operations/workspaces.ts) | `workspace.list` (authenticated), `workspace.create` and `workspace.delete` (instance admin), `workspace.update`, `workspace.reorderBoards`, `workspace.member.set`, `workspace.member.remove`, `workspace.member.candidates` (workspace admin). |
| [server/operations/board-domain.ts](../server/operations/board-domain.ts) | `board.create` (workspace admin, default workspace fallback), `board.move`, `board.duplicate` (board admin). |
| [server/utils/access.ts](../server/utils/access.ts) | `requireWorkspaceAccess`: the derived visibility rule, the implicit admin for instance administrators, the 404 for board-pinned tokens. |
| [server/utils/db.ts](../server/utils/db.ts) | `ensureWorkspaces`, `ensureWorkspaceDescription` (migrations); `listWorkspaces`, `findWorkspace`, `createWorkspace`, `updateWorkspace`, `deleteWorkspace`, `countWorkspaces`, `defaultWorkspaceId`, `workspaceRoleFor`, `workspaceMembers`, `workspaceReachableThroughBoards`, `moveBoardToWorkspace`, `duplicateBoard`, `reorderWorkspaceBoards`. Tables `workspaces`, `workspace_members`; `boards.workspace_id`. |
| [shared/types/domain.ts](../shared/types/domain.ts), [shared/schemas/domain.ts](../shared/schemas/domain.ts) | `Workspace`, `WorkspaceSummary`, `WorkspaceMember`, `WorkspaceRole` and their Zod twins. |
| [shared/utils/constants.ts](../shared/utils/constants.ts) | `DEFAULT_WORKSPACE_NAME`, the name that keeps the switcher hidden. |
| `app/composables/useWorkspaces.ts` | Workspace list state, `useCurrentWorkspace`, `useLastWorkspaceId` (cookie `open-bugster-workspace`). |
| `app/components/WorkspaceSwitcher.vue` | The header switcher; renders nothing for a single untouched workspace. |
| `app/pages/admin/workspaces.vue` | The instance-level overview: every workspace, and where new ones are created. |
| `app/pages/w/[workspace]/settings.vue` | One workspace's settings page with its stacked sections. |
| `app/middleware/workspace.ts`, `home-board.ts` | Resolving the route parameter; landing on a board inside the selected workspace. |

## Surfaces

- **Internal routes:** `server/api/workspaces/index.get.ts`, `index.post.ts`, `[id].patch.ts`, `[id].delete.ts`, `[id]/board-order.patch.ts`, `[id]/members/[userId].put.ts`, `[id]/members/[userId].delete.ts`, `[id]/members/candidates.get.ts`; `server/api/boards/[id]/move.post.ts`, `duplicate.post.ts`.
- **REST v1:** `GET /workspaces` only. Board payloads carry `workspaceId`, and `POST /boards` accepts one. Workspace management stays internal, for the same reason user administration does.
- **MCP:** `list_boards` and `board_overview` report the workspace a board belongs to. There is no workspace tool.
- **Webhooks:** none. Webhooks are board-scoped.

## Tests

- `tests/workspaces.test.ts`: the migration (one default workspace, every board adopted, positions preserved, re-run is a no-op), derived visibility, the workspace scope guard, board move and duplicate.
- `tests/operations.test.ts`, `tests/audit.test.ts`: workspace operations audit with `targetType: 'workspace'` and no board id.
