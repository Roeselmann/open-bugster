# Boards, lanes, categories, and labels

A board is one Kanban board with its own lanes, categories, labels, members, archive, and App Store Connect credentials. An instance runs any number of boards, typically one per app or project, grouped into [workspaces](workspaces.md).

## Using it

### Boards

The board name in the header becomes a dropdown as soon as a second board exists. The icon next to it opens the board settings and is shown to board administrators only. A newly created board is selected right away and opens its settings so lanes and credentials can be set up.

The settings are split into sections: **Board** for the name, description, lanes, categories, moving, duplicating, and deletion; **Users** for who has access; **Integration** for the App Store Connect key; **Webhooks** for outgoing events; **Audit** for the change log.

Deleting a board removes all of it, including attachments and the stored key. The last board of an instance cannot be deleted.

### Lanes

Lanes are the columns of the board and are configured under **Board settings → Board**. Drag a lane by its handle to reorder it, or focus the handle and use the arrow keys. Top to bottom in the settings is left to right on the board.

Every board has exactly one **import lane**, which is where TestFlight feedback lands. It can be renamed and reordered, but not deleted, and it only appears on the board once something has been imported into it.

When a lane is deleted, its tickets are not lost: the dialog asks whether they should move to another lane or go to the archive.

<p align="center">
<img src="images/screenshot-settings-board.png">
</p>

Each lane header carries a switch that shows or hides screenshot previews on its cards. The choice is remembered per lane and browser.

### Categories

A ticket has at most one category. New categories are created from within a ticket by typing a name that does not exist yet. Under **Board settings → Board** each category can be renamed in place and given one of eight color presets. The color is what the category pill uses on the cards and in the archive.

### Labels

Labels are a per-board list, edited directly in the ticket. The field suggests the board's existing labels while typing; a name that does not exist yet is offered as a new entry and created when the ticket is saved. A ticket holds up to twelve labels of thirty characters each.

Labels clean themselves up: when the last ticket that carried a label drops it, the label disappears from the board's list.

Next to the board search sits the same control as a filter. Picking several labels shows the tickets that carry **any** of them.

## How it works

- **Board access is membership.** `requireBoardAccess` answers 404 for a board the caller is not a member of, unless they are an instance administrator. Reads need `viewer`, configuration needs `admin`.
- **The import lane is a flag in the data layer**, not a convention. `deleteLane` refuses it, it is excluded from default lanes on a fresh board, and the board hides it while it is empty.
- **Lane deletion is a two-mode operation.** `lane.delete` takes `mode: 'move'` with a `targetLaneId` or `mode: 'archive'`; the data layer moves or archives the tickets inside one transaction and throws `LaneDeleteError` with a status code for the cases it refuses.
- **Categories belong to a board** and are created implicitly through `ticket.create` and `ticket.update` by `categoryName`. Names are unique per board (`CategoryNameTakenError`).
- **Labels have no create operation.** They come into being through the label list of a ticket and are pruned when unreferenced.
- **A board always keeps at least one administrator**; `member.remove` and `member.set` refuse to demote or remove the last one.
- **Board names** are at most 40 characters, descriptions 200, lane and category names 30.

## Code map

| File | What lives there |
|---|---|
| [server/operations/board-domain.ts](../server/operations/board-domain.ts) | `board.list` (authenticated), `board.get` (viewer), `board.create` (workspace admin), `board.update`, `board.move`, `board.duplicate`, `board.delete` (board admin); `lane.list` (viewer), `lane.create`, `lane.update`, `lane.reorder`, `lane.delete` (admin); `category.list` (viewer), `category.update`, `category.delete` (admin); `label.list` (viewer); `member.list` (viewer), `member.candidates`, `member.set`, `member.remove` (admin). |
| [server/utils/db.ts](../server/utils/db.ts) | Boards: `listBoards`, `accessibleBoardIds`, `boardRoleFor`, `findBoard`, `createBoard`, `updateBoard`, `deleteBoard`, `countBoards`. Lanes: `createLane`, `updateLane`, `reorderLanes`, `deleteLane`, `LaneDeleteError`. Categories: `listCategories`, `updateCategory`, `deleteCategory`. Labels: `listLabels`. Members: `boardMembers`, `setBoardMember`, `removeBoardMember`, `countBoardAdmins`. Tables `boards`, `lanes`, `categories`, `labels`, `ticket_labels`, `board_members`. |
| [server/utils/validation.ts](../server/utils/validation.ts) | `boardCreateSchema`, `boardUpdateSchema`, `laneSchema`, `categoryUpdateSchema`, and the label length rule. |
| [shared/types/domain.ts](../shared/types/domain.ts) | `Board`, `BoardSummary`, `Lane`, `LaneSummary`, `Category`, `CategorySummary`, `CategoryColor`, `LabelSummary`, `BoardMember`, `BoardRole`. |
| [shared/utils/constants.ts](../shared/utils/constants.ts) | `CATEGORY_COLOR_LABELS`, `CATEGORY_TONE_CLASSES` (hand-written CSS classes, because Tailwind cannot scan class names that only exist as strings). |
| `app/composables/useBoards.ts` | Board list state, `useCurrentBoard`, `useLastBoardId` (cookie `open-bugster-board`), `useCanAutomate`. |
| `app/components/BoardSwitcher.vue`, `AppHeader.vue` | The header dropdown and the settings icon. |
| `app/components/BoardLaneSettings.vue`, `BoardCategorySettings.vue`, `BoardMemberSettings.vue` | The settings panels. |
| `app/pages/b/[board]/settings.vue` and `settings/board.vue`, `users.vue` | The settings shell and the two sections this document covers. |
| `app/middleware/board.ts` | Resolves `:board` into the current board or 404s. |

## Surfaces

- **Internal routes:** `server/api/boards/index.get.ts`, `index.post.ts`, `[id].patch.ts`, `[id].delete.ts`, `[id]/move.post.ts`, `[id]/duplicate.post.ts`, `[id]/lanes/index.post.ts`, `[id]/lanes/[laneId].patch.ts`, `[id]/lanes/[laneId].delete.ts`, `[id]/lane-order.patch.ts`, `[id]/members/*`; `server/api/categories/index.get.ts`, `[id].patch.ts`, `[id].delete.ts`; `server/api/labels/index.get.ts`.
- **REST v1:** `GET|POST /boards`, `GET|PATCH|DELETE /boards/{boardId}`, `GET|POST /boards/{boardId}/lanes`, `PATCH|DELETE /boards/{boardId}/lanes/{laneId}`, `PATCH /boards/{boardId}/lane-order`, `GET /boards/{boardId}/members`, `GET /boards/{boardId}/member-candidates`, `PUT|DELETE /boards/{boardId}/members/{userId}`, `GET /boards/{boardId}/categories`, `PATCH|DELETE /categories/{categoryId}`, `GET /boards/{boardId}/labels`.
- **MCP:** `list_boards`, `board_overview`, `list_lanes`.
- **Webhooks:** none of the operations here emit an event. Webhooks are about tickets, comments, and imports.

## Tests

- `tests/lanes.test.ts`: boards and lanes, including both lane deletion modes and the import lane rule.
- `tests/workspaces.test.ts`: board move and duplicate.
- `tests/accounts.test.ts`: board membership and the last-administrator rule.
