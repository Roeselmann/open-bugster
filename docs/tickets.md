# Tickets

A ticket is a card on a board: a title, a description, an internal comment, priority, due date, build number, any number of links to things elsewhere, a to-do list, attachments, one category, any number of labels, an assignee, a comment thread, and a history. Imported TestFlight feedback and Jira issues become tickets too, with the original submission or issue attached. The build number, in the editor and on the card, only appears on boards with TestFlight connected. A card whose due date comes near gets an orange border, then a red one, which stays while it is overdue; how many days ahead each colour starts is set per board under **Board settings → Board** (defaults: orange 7 days before, red 1 day before). As soon as any of your boards has a ticket with a due date, an alarm clock appears in the header: grey with the number of due dates while none is lit, red with the number of orange and red ones once any is. It opens every due date, grouped by workspace and board, linking to each of them and opening the ticket itself. Tickets are moved by dragging, archived instead of deleted, and numbered instance-wide.

## Using it

### Creating and editing

New tickets are created with **Add ticket** at the bottom of a lane, or with the **+** in a lane's header to put one at the top; the editor lets you change the lane and the position before saving. Either way they land in that lane. An open ticket can be sent to the top or bottom of its lane with the two arrow buttons beside the **Lane** select. Imported tickets additionally show their origin: the TestFlight feedback with tester, device, system, locale, and build, or the Jira issue with key, project, type, status, priority, reporter, and assignee as they were at import. A board administrator can set the **Author** by hand, which is how an import that arrived before anyone had an account gets one afterwards.

The description is Markdown. A ticket that already has one opens with the rendered text; **Edit** (or a click on the text) brings back the editor. The **Save** beside the field stores just the description right away and shows the rendered result without closing the ticket; **Cancel** drops the unsaved changes and returns to the rendered view. A ticket without a description starts in the editor. Viewers see the rendered text only.

Cards are moved by dragging them between lanes or within a lane. On narrow screens each card offers a lane dropdown instead.

### To-dos and attachments

Each ticket carries a to-do list: record the next steps, reorder them, and tick them off. Files such as screenshots and documents are attached directly to the ticket; images open in a lightbox. The files and links share a side column at the right of the ticket. Drag the handle in the middle of its left edge to widen it, up to the width of the comments column. The drawer grows by as much, so the fields and the comments keep their width; only a window too narrow for the wider drawer stops the drag earlier. Wider, the files and link cards sit side by side. The width holds for every ticket in this browser, and a double-click on the handle (or Home with the handle focused, the arrow keys in between) goes back to the narrow default. Each file is at most 25 MB, a ticket holds up to ten, and the file type has to be on the allowlist. Imported tickets work the same way: they take further files, and every attachment, including the screenshots, crash logs and Jira files an import brought along, can be deleted.

### Pictures on the card

With the picture switch in a lane's header on, its cards show pictures. Every image attachment and every link shown with a rendered preview carries a **Card** checkbox in the editor's side column; tick as many as the card should show. One picture fills the card's width; several share it in pairs, and past four the last one says how many more there are. As long as nobody ticked anything, the card shows one picture on its own: the oldest image attachment, or, on a ticket without one, the first link preview. Unticking everything is a choice too and leaves the card without a picture. A link switched back to plain text takes its preview off the card.

### Links

Links sit in the ticket's side column, stacked under the files: paste an address into the field below them, or type it and press Enter. A new link shows as its bare address. The picture button beside it (**Show with preview**) turns it into a card: a thumbnail of the page as a browser shows it, its title, and a line of its description from the page's Open Graph or Twitter tags. Only then is the page read and rendered, so a ticket full of plain links costs the server nothing. Rendering takes a few seconds and carries on when the ticket is closed; a toast says when the preview is ready, or that the page could not be rendered. Where the page cannot be rendered, the picture the page names for previews stands in, then the first photo of its content (menus, logos, icons, SVGs, and pictures too small or too stretched to be a photo are passed over), and finally a generic thumbnail with the host. The text button on a card (**Show as text only**) goes back to the bare address; another one renders the page again. Links carried over from the single link a ticket used to have, and the issue link a Jira import starts with, are plain addresses too. The card on the board shows the host of the first link and how many more there are.

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
- **Due date colours are computed, not stored.** `dueLevel` in `shared/utils/due-date.ts` compares a due date with today in Berlin time against the board's `dueWarningDays` and `dueAlertDays`; the card and `ticket.listDue` (behind the header alarm, `GET /api/tickets/due`) both use it. `/b/{board}?ticket=42` opens that ticket on arrival.
- **Positions are per lane.** `moveTicket` takes a lane and an index and renumbers the lane. `ticket.create` takes a `placement` (`top` or `bottom`, default `bottom`) and, for `top`, renumbers the lane the same way.
- **To-dos are replaced as a whole list** on `ticket.create` and `ticket.update`, up to 100 entries of 500 characters. Titles are at most 160 characters, descriptions 10,000.
- **Descriptions and comments are Markdown**, rendered by `renderMarkdown` with raw HTML switched off: a `<script>` in the text is shown as text, `javascript:` and `data:` links are dropped, and every link opens in a new tab with `rel="noopener noreferrer"`. That is what makes the output safe for `v-html` without a DOM-based sanitizer, so it works in SSR and in the node-only tests.
- **Links are replaced as a whole list** on `ticket.create` and `ticket.update` as `links: [{ url, display }]`, up to 50, http(s) only; `display` is `text` (the default) or `preview`. An address the ticket already had keeps its row and its preview, so re-sending the list does not read every page again, and a repeated address counts once. The single `link` field from before still works: on a ticket it reads as the first link, and setting it replaces the first link and keeps the rest. The old `tickets.link` column was copied into `ticket_links` once and is no longer read.
- **Previews are read lazily.** A new link is `pending`; the editor asks `POST /api/links/{id}/preview` only once the link is shown as a preview, so saves stay fast and an import never reads a hundred pages. The server follows up to four redirects for the page's tags, screening every hop like a webhook target (link-local always refused, private ranges per `WEBHOOK_ALLOW_PRIVATE`), and reads at most 768 KB of the page.
- **The thumbnail is a render.** `renderPageThumbnail` opens the page in headless Chromium (Playwright) at 1280×720 and keeps its first screen as a 640×360 JPEG beside the ticket's attachments. Every request the page makes — the document, redirects, scripts, images, frames, fetches — is screened exactly like the link itself, and WebSockets, service workers, downloads, pop-ups and dialogs are refused, so a page cannot point the server at the metadata service or the internal network. Consent banners of the common platforms are hidden, never clicked. One browser is shared, started on the first render and closed after a minute without one; two renders run at once. Without a browser (`LINK_PREVIEW_RENDER=false`, or none installed) the page's own image is cropped instead. SVGs are never decoded. The thumbnail is served from `GET /api/links/{id}/thumbnail` to whoever can read the ticket, never hot-linked: the content policy keeps images to this origin, and the remote site would otherwise learn about every view. Reading a preview again over an existing one (`refresh`) needs `editor`.
- **Categories and labels are set by name.** `categoryName` creates the category if needed; `labels` creates missing labels and prunes those left without a ticket.
- **The card's pictures are a list of ids.** `tickets.card_images` holds the ticked attachment and link ids as JSON, NULL while nobody ticked; `cardImages` in `shared/utils/card-images.ts` turns it into what the card shows, defaults included, for the card and the editor alike. A pick of which nothing is left on the ticket reads as unpicked. `cardImageIds` on an update replaces the pick (an empty list shows none, null goes back to the default) and takes only pictures `cardImageCandidates` offers. The older `coverAttachmentId` is still read and written as a pick of one, and the `cover_attachment_id` column keeps the first ticked attachment for an instance rolled back.
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
| [server/utils/db.ts](../server/utils/db.ts) | `listTickets`, `listTicketsPage`, `findTicket`, `ticketIdByNumber`; `createTicket`, `updateTicket`, `moveTicket`, `archiveTicket`, `restoreTicket`; comments and `listActivity`, `recordActivity`. `findTicketLink`, `saveLinkPreview`. Tables `tickets`, `ticket_todos`, `ticket_links`, `ticket_labels`, `attachments`, `apple_feedback`, `jira_issues`, `ticket_comments`, `ticket_activity`. |
| [server/utils/attachment-policy.ts](../server/utils/attachment-policy.ts) | `MAX_ATTACHMENT_SIZE`, `MAX_ATTACHMENT_COUNT`, the extension allowlist, and the signature check. |
| [server/utils/attachment-file.ts](../server/utils/attachment-file.ts) | Storing files under `ATTACHMENTS_PATH` and resolving stored paths safely. |
| [server/utils/attachment-fetch.ts](../server/utils/attachment-fetch.ts) | The server-side download behind `attachment.addFromUrl`. |
| [server/utils/link-preview.ts](../server/utils/link-preview.ts) | Reading a link's page and image, `refreshLinkPreview`, and removing thumbnails no link uses. |
| [server/utils/page-render.ts](../server/utils/page-render.ts) | `renderPageThumbnail`: the shared headless browser, request screening, the screenshot. |
| [server/utils/validation.ts](../server/utils/validation.ts) | `ticketCreateSchema`, `ticketUpdateSchema`, `todoSchema`, the label and category name rules. |
| [shared/types/domain.ts](../shared/types/domain.ts) | `Ticket`, `TicketPriority`, `TicketTodo`, `Attachment`, `TicketComment`, `TicketActivityEntry`, `AppleFeedback`. |
| `app/components/KanbanBoard.vue` | Lanes, drag-and-drop between and within lanes, the lane dropdown on narrow screens. |
| `app/components/TicketCard.vue`, `PriorityPill.vue` | The card. |
| `app/components/TicketEditor.vue` | The ticket dialog: fields, to-dos, labels, category, attachments, author, assignee. |
| `app/components/TicketLinks.vue`, `app/composables/useLinkPreviews.ts` | The link list in the side column: bare addresses or cards with thumbnails, adding, removing, switching; previews that outlive the drawer, and their toast. |
| `app/components/CardImageToggle.vue`, `shared/utils/card-images.ts` | The **Card** checkbox over a picture in the side column, and the rule for which pictures a card shows. |
| `app/components/TicketComments.vue`, `TicketActivity.vue` | The thread and the history. |
| [shared/utils/markdown.ts](../shared/utils/markdown.ts), `app/components/MarkdownView.vue` | `renderMarkdown` and the component that shows its output; the `.md-body` styles live in `app/assets/css/main.css`. |
| `app/components/BoardFilterPane.vue`, `ImageLightbox.vue` | Filtering and search; image preview. |
| `app/pages/b/[board]/index.vue`, `archive.vue` | The board and the archive view. |

## Surfaces

- **Internal routes:** `server/api/tickets/index.get.ts`, `index.post.ts`, `[id].get.ts`, `[id].patch.ts`, `[id]/position.patch.ts`, `[id]/archive.post.ts`, `[id]/restore.post.ts`, `[id]/activity.get.ts`, `[id]/attachments.post.ts`, `[id]/comments.get.ts`, `[id]/comments.post.ts`; `server/api/attachments/[id].get.ts`, `[id].delete.ts`; `server/api/links/[id]/preview.post.ts`, `[id]/thumbnail.get.ts`; `server/api/comments/[id].patch.ts`, `[id].delete.ts`.
- **REST v1:** `GET /boards/{boardId}/tickets` (cursor paged), `POST /tickets`, `GET|PATCH /tickets/{ticketId}`, `GET /tickets/by-number/{ticketNumber}`, `POST /tickets/{ticketId}/move|transfer|archive|restore`, `GET /tickets/{ticketId}/activity`, `GET /attachments/{attachmentId}` (download), `POST /tickets/{ticketId}/attachments` and `/attachments/from-url`, `GET|POST /tickets/{ticketId}/comments`, `PATCH|DELETE /comments/{commentId}`.
- **MCP:** `search_tickets`, `get_ticket`, `create_ticket`, `update_ticket`, `move_ticket`, `comment_on_ticket`, `archive_ticket`, `restore_ticket`, `add_attachment`, `whats_new`.
- **Webhooks:** `ticket.created`, `ticket.updated`, `ticket.moved`, `ticket.transferred`, `ticket.archived`, `ticket.restored`, `comment.added`.

## Tests

- `tests/db.test.ts`: ticket persistence, to-dos, links, labels, categories, move and archive.
- `tests/link-preview.test.ts`: reading a page's tags, following redirects, cropping the thumbnail, refusing SVG.
- `tests/page-render.test.ts`: rendering a page in Chromium while every request to link-local addresses and every socket is refused. Skipped where no browser is installed.
- `tests/card-images.test.ts`: which pictures a card offers and shows, and the default without a pick.
- `tests/operations.test.ts`: ticking pictures for the card, refusing foreign ones, and falling back once they are gone.
- `tests/attachment-policy.test.ts`: the type and signature allowlist.
- `tests/attachment-file.test.ts`: a stored path cannot escape the attachments directory.
- `tests/validation.test.ts`: the ticket schemas.
- `tests/markdown.test.ts`: raw HTML is escaped, script-scheme links are dropped, links open in a new tab.
- `tests/mcp.test.ts`, `tests/api-v1.test.ts`: the ticket tools and routes, including cursor paging.
