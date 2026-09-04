# Tickets

A ticket is a card on a board: a title, a description, an internal comment, priority, due date, build number, an optional link to something elsewhere, a to-do list, attachments, one category, any number of labels, an assignee, a comment thread, and a history. Imported TestFlight feedback and Jira issues become tickets too, with the original submission or issue attached. Tickets are moved by dragging, archived instead of deleted, and numbered instance-wide.

## Using it

### Creating and editing

New tickets are created with **Add ticket** at the bottom of a lane, or with the **+** in a lane's header to put one at the top; the editor lets you change the lane and the position before saving. Either way they land in that lane. An open ticket can be sent to the top or bottom of its lane with the two arrow buttons beside the **Lane** select. Imported tickets additionally show their origin: the TestFlight feedback with tester, device, system, locale, and build, or the Jira issue with key, project, type, status, priority, reporter, and assignee as they were at import. A board administrator can set the **Author** by hand, which is how an import that arrived before anyone had an account gets one afterwards.

The description is Markdown. A ticket that already has one opens with the rendered text; **Edit** (or a click on the text) brings back the editor. The **Save** beside the field stores just the description right away and shows the rendered result without closing the ticket; **Cancel** drops the unsaved changes and returns to the rendered view. A ticket without a description starts in the editor. Viewers see the rendered text only.

Cards are moved by dragging them between lanes or within a lane. On narrow screens each card offers a lane dropdown instead.

### To-dos and attachments

Each ticket carries a to-do list: record the next steps, reorder them, and tick them off. Files such as screenshots and documents are attached directly to the ticket; images open in a lightbox. Each file is at most 25 MB, a ticket holds up to ten, and the file type has to be on the allowlist.

### Assignment and discussion

A ticket can be assigned to any member of its board, and the assignee's avatar appears on the card. The **All assignees** filter next to the search box narrows the board to your own work, to a colleague's, or to everything nobody has picked up yet.

Each ticket carries a comment thread, open to viewers as well, and a history that records when it was created, moved, assigned, re-prioritised, archived, or restored, and through which agent when a token acted. Comments are Markdown like the description. Authors edit and delete their own comments; board administrators can also remove someone else's.

### Filtering and searching

The filter pane narrows the board by labels (any of the picked ones), category, or assignee, including everything still unassigned. The search box matches titles, descriptions, to-dos, authors, assignees, build numbers, links, Jira issue keys, and ticket numbers.

### Archive

**Archive** removes a ticket from the board without losing it, and an archived import is never imported again by a later sync. Editors archive; the archive itself belongs to the board's administrators. Only they see its icon in the header, reach the archive view, and restore from it. For everyone else an archived ticket is simply gone, including through its own address, and the dialog says as much before an editor archives anything.

## How it works

- **Roles.** Reading needs `viewer`; creating, editing, moving, and archiving need `editor`; restoring needs `admin`. An archived ticket answers 404 to anyone below admin.
- **Ticket numbers are instance-global**, so a number is a handle that works across boards and in a commit message. `ticket.getByNumber` needs no board.
- **Positions are per lane.** `moveTicket` takes a lane and an index and renumbers the lane. `ticket.create` takes a `placement` (`top` or `bottom`, default `bottom`) and, for `top`, renumbers the lane the same way.
- **To-dos are replaced as a whole list** on `ticket.create` and `ticket.update`, up to 100 entries of 500 characters. Titles are at most 160 characters, descriptions 10,000.
- **Descriptions and comments are Markdown**, rendered by `renderMarkdown` with raw HTML switched off: a `<script>` in the text is shown as text, `javascript:` and `data:` links are dropped, and every link opens in a new tab with `rel="noopener noreferrer"`. That is what makes the output safe for `v-html` without a DOM-based sanitizer, so it works in SSR and in the node-only tests.
- **Categories and labels are set by name.** `categoryName` creates the category if needed; `labels` creates missing labels and prunes those left without a ticket.
- **Attachments are validated twice**: by extension allowlist and by magic-byte signature, for uploads and for server-side downloads alike. Stored paths are resolved against the attachments directory and refused if they escape it.
- **Server-side download** (`attachment.addFromUrl`) screens the URL like a webhook destination, refuses redirects, and reads the body under a running 25 MB cap. See [mcp-server.md](mcp-server.md) for why it exists.
- **History stores people by reference.** Activity rows carry the actor's id and, for tokens, the agent label; names are resolved when rendered. See [users-and-access.md](users-and-access.md).
- **Paging.** `ticket.list` is unpaged for the UI and paged with a cursor on the REST surface, which defaults to 100 per page.

## Code map

| File | What lives there |
|---|---|
| [server/operations/tickets.ts](../server/operations/tickets.ts) | `ticket.list`, `ticket.get`, `ticket.getByNumber`, `ticket.activity`, `board.activity` (viewer); `ticket.create`, `ticket.update`, `ticket.move`, `ticket.archive` (editor); `ticket.restore` (admin). |
| [server/operations/attachments.ts](../server/operations/attachments.ts) | `attachment.get` (viewer), `attachment.add` (base64 body), `attachment.addFromUrl` (editor). |
| [server/operations/board-domain.ts](../server/operations/board-domain.ts) | `comment.list`, `comment.add` (viewer on the ticket), `comment.update`, `comment.remove` (author or board admin). |
| [server/utils/db.ts](../server/utils/db.ts) | `listTickets`, `listTicketsPage`, `findTicket`, `ticketIdByNumber`; `createTicket`, `updateTicket`, `moveTicket`, `archiveTicket`, `restoreTicket`; comments and `listActivity`, `recordActivity`. Tables `tickets`, `ticket_todos`, `ticket_labels`, `attachments`, `apple_feedback`, `jira_issues`, `ticket_comments`, `ticket_activity`. |
| [server/utils/attachment-policy.ts](../server/utils/attachment-policy.ts) | `MAX_ATTACHMENT_SIZE`, `MAX_ATTACHMENT_COUNT`, the extension allowlist, and the signature check. |
| [server/utils/attachment-file.ts](../server/utils/attachment-file.ts) | Storing files under `ATTACHMENTS_PATH` and resolving stored paths safely. |
| [server/utils/attachment-fetch.ts](../server/utils/attachment-fetch.ts) | The server-side download behind `attachment.addFromUrl`. |
| [server/utils/validation.ts](../server/utils/validation.ts) | `ticketCreateSchema`, `ticketUpdateSchema`, `todoSchema`, the label and category name rules. |
| [shared/types/domain.ts](../shared/types/domain.ts) | `Ticket`, `TicketPriority`, `TicketTodo`, `Attachment`, `TicketComment`, `TicketActivityEntry`, `AppleFeedback`. |
| `app/components/KanbanBoard.vue` | Lanes, drag-and-drop between and within lanes, the lane dropdown on narrow screens. |
| `app/components/TicketCard.vue`, `PriorityPill.vue` | The card. |
| `app/components/TicketEditor.vue` | The ticket dialog: fields, to-dos, labels, category, attachments, author, assignee. |
| `app/components/TicketComments.vue`, `TicketActivity.vue` | The thread and the history. |
| [shared/utils/markdown.ts](../shared/utils/markdown.ts), `app/components/MarkdownView.vue` | `renderMarkdown` and the component that shows its output; the `.md-body` styles live in `app/assets/css/main.css`. |
| `app/components/BoardFilterPane.vue`, `ImageLightbox.vue` | Filtering and search; image preview. |
| `app/pages/b/[board]/index.vue`, `archive.vue` | The board and the archive view. |

## Surfaces

- **Internal routes:** `server/api/tickets/index.get.ts`, `index.post.ts`, `[id].get.ts`, `[id].patch.ts`, `[id]/position.patch.ts`, `[id]/archive.post.ts`, `[id]/restore.post.ts`, `[id]/activity.get.ts`, `[id]/attachments.post.ts`, `[id]/comments.get.ts`, `[id]/comments.post.ts`; `server/api/attachments/[id].get.ts`, `[id].delete.ts`; `server/api/comments/[id].patch.ts`, `[id].delete.ts`.
- **REST v1:** `GET /boards/{boardId}/tickets` (cursor paged), `POST /tickets`, `GET|PATCH /tickets/{ticketId}`, `GET /tickets/by-number/{ticketNumber}`, `POST /tickets/{ticketId}/move|transfer|archive|restore`, `GET /tickets/{ticketId}/activity`, `GET /attachments/{attachmentId}` (download), `POST /tickets/{ticketId}/attachments` and `/attachments/from-url`, `GET|POST /tickets/{ticketId}/comments`, `PATCH|DELETE /comments/{commentId}`.
- **MCP:** `search_tickets`, `get_ticket`, `create_ticket`, `update_ticket`, `move_ticket`, `comment_on_ticket`, `archive_ticket`, `restore_ticket`, `add_attachment`, `whats_new`.
- **Webhooks:** `ticket.created`, `ticket.updated`, `ticket.moved`, `ticket.transferred`, `ticket.archived`, `ticket.restored`, `comment.added`.

## Tests

- `tests/db.test.ts`: ticket persistence, to-dos, labels, categories, move and archive.
- `tests/attachment-policy.test.ts`: the type and signature allowlist.
- `tests/attachment-file.test.ts`: a stored path cannot escape the attachments directory.
- `tests/validation.test.ts`: the ticket schemas.
- `tests/markdown.test.ts`: raw HTML is escaped, script-scheme links are dropped, links open in a new tab.
- `tests/mcp.test.ts`, `tests/api-v1.test.ts`: the ticket tools and routes, including cursor paging.
