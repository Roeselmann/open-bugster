# Jira import

A board can pull issues from a Jira Cloud site. The board's administrator stores an Atlassian API token and a JQL query; a sync imports the issues the query matches that are not on the board yet, with title, description, comments, priority, reporter, and attachments. From then on the ticket lives in Open-Bugster: it is a one-way import, nothing is written back to Jira, and later changes in Jira do not reach the ticket. The Jira connection is configured per board, next to TestFlight, and a board without one is simply a board.

## Using it

### What is needed

| Value | Where it comes from |
| --- | --- |
| **Jira site** | The address of the Jira Cloud site, `https://<team>.atlassian.net`. A pasted issue link is reduced to its site. |
| **Atlassian account email** | The email of the account the token belongs to. |
| **API token** | Created under Atlassian account → Security → [API tokens](https://id.atlassian.com/manage-profile/security/api-tokens). Atlassian tokens expire after at most one year; the sync reports when one has. |
| **JQL** | Which issues to import. A new board is offered `assignee = currentUser() AND statusCategory != Done`, the token owner's own open issues. |

The token inherits the permissions of its account: the import sees exactly what that person sees in Jira, and reads under their name.

### Entering them

Open **Board settings → Jira**, enter the site and the email, paste the token and press **Store token**, write the JQL, and **Save**. The token is stored encrypted, never written to disk, and never sent back to the browser; the page shows only its last four characters. It can be replaced or removed at any time.

**Items per sync**, **Attribute imports to the person they name**, and **Type for imported tickets** are shared with the TestFlight tab: they belong to the board and apply to every import on it.

### Test connection

**Test connection** asks Jira who the token belongs to, checks that the JQL parses, and reports how many issues it currently matches. It imports nothing and writes nothing. It checks the values currently in the form, saved or not; only the token always comes from the vault.

### Sync

**Jira sync** in the header imports everything the query matches that is not on the board yet. The button and the last-run line belong to board administrators and appear once the connection is complete. New tickets land in the import lane with a `Jira` label and one for the issue type (`Bug`, `Story`, …). The ticket's **Link** field holds the issue's address, editable like on any other ticket. The card shows the issue key; the ticket shows a **Jira issue** panel with key, project, type, status, priority, reporter, assignee, and labels as they were in Jira at the time, and the key links back to the issue.

The description arrives as Markdown converted from Jira's rich text, followed by a **Comments from Jira** section holding the comments the issue had. Attachments are downloaded under the usual attachment policy: at most ten per ticket, 25 MB each, known file types only.

**Items per sync** caps how many results a sync inspects, in the order Jira returns them; raise it for a board whose query matches more than that, and end the query with an `ORDER BY` so the newest come first. An archived Jira ticket is never imported again.

### Writing the query

The query is sent to Jira exactly as written: nothing is appended, no time window, no ordering. **How to write the query** under the field opens a help panel with a short guide, links to Atlassian's JQL reference, and a list of common queries — my open issues, open bugs of one project, created in the last 30 days, the current sprint, and so on — each with a **Use** button that puts it into the field. Test a query in Jira's own issue search first if in doubt; **Test connection** reports how many issues it matches.

## How it works

- **Authentication** is HTTP basic auth with `email:token`, the scheme Jira Cloud offers for API tokens. Every request is pinned to the configured site; a link Jira hands back that points elsewhere is refused.
- **Search** goes through `POST /rest/api/3/search/jql`, the enhanced search that replaced `/rest/api/3/search` in 2025, paged by `nextPageToken`. The board's JQL is sent verbatim and the scan stops after `syncLimit` issues. There is deliberately no import window: the query is the selection, a user can see exactly what runs, and the help panel explains how to narrow and order it. Unlike TestFlight, which has no query to narrow, the sync does not use `computeImportCutoff`.
- **Deduplication** is by Jira's numeric issue id in `tickets.external_id`, unique per board. The id survives a move between projects; the key is kept as metadata. Archived tickets keep their id, which is what stops a re-import.
- **Descriptions and comments** come from the v3 API as Atlassian Document Format and are converted to Markdown by `adfToMarkdown`: paragraphs, headings, lists, task lists, code blocks, quotes, panels, tables, links, mentions, and media placeholders. Unknown nodes keep their text.
- **Priority** maps Jira's default scheme onto the board's four levels: Highest, Blocker, and Critical become urgent; High and Major high; Low, Lowest, Minor, and Trivial low; everything else medium.
- **Attribution** works as for TestFlight, with one caveat: Jira Cloud withholds most email addresses. When the reporter's address is present, they get a contact row and become the author if they already have an account and the board asks for it; otherwise the reporter is recorded by name only.
- **Attachments** are downloaded from Jira's `attachment/content` endpoint, which answers with a redirect to a signed media URL; `fetch` follows it and drops the credentials on the way. Size and type are checked before and after the download. Images are stored as screenshots, everything else as files.
- **A sync is a `sync_runs` row** with `provider = 'jira'` and an in-process lock per board and provider, so a Jira sync and a TestFlight sync can run side by side but not two of the same. A run ends as `success`, `partial` (some issues or attachments failed), or `failed`.
- **Credentials** live in `board_integrations`, one row per board and provider: the site, email, and JQL as JSON, the token sealed with AES-256-GCM under `BUGSTER_SECRET_KEY`, exactly as the TestFlight `.p8` is.

## Code map

| File | What lives there |
|---|---|
| [server/utils/jira.ts](../server/utils/jira.ts) | `JiraApiError`, `basicAuthorization`, the pinned `jiraFetch`, `verifyJiraAccess`, `syncJira` (lock, cutoff, paging, attachments, run status). |
| [server/utils/jira-policy.ts](../server/utils/jira-policy.ts) | `normalizeSiteUrl`, `isJiraSiteUrl`, `jiraPriorityToBugster`, `titleFromIssue`, `issueUrl`, `tokenLabel`, `describeIssue`. |
| `app/components/JqlHelp.vue` | The help panel under the query field: guide, reference links, common queries with **Use**. |
| [server/utils/adf.ts](../server/utils/adf.ts) | `adfToMarkdown`. |
| [server/utils/sync-lock.ts](../server/utils/sync-lock.ts) | `acquireSyncLock`, shared with the TestFlight sync. |
| [server/operations/board-domain.ts](../server/operations/board-domain.ts) | `jira.setToken`, `jira.clearToken`, `jira.testConnection` (board admin); `import.run` and `import.status` with `provider`. |
| [server/utils/db.ts](../server/utils/db.ts) | `ensureBoardIntegrations`, `ensureSyncRunProvider`, `ensureTicketSourceJira`; `setBoardJiraToken`, `clearBoardJiraToken`, `boardJiraCredentials`; `insertImportedTicket` with a `JiraImportInput`; tables `board_integrations`, `jira_issues`. |
| [server/utils/validation.ts](../server/utils/validation.ts) | `boardUpdateSchema.jira`, `jiraConnectionTestSchema`, `jiraTokenSchema`, `importRequestSchema.provider`. |
| [shared/utils/ticket-source.ts](../shared/utils/ticket-source.ts) | `PROVIDER_LABELS`, `sourceLabel`, `providerLabel`, used wherever the UI names a source. |
| `app/components/BoardJiraSettings.vue`, `app/pages/b/[board]/settings/jira.vue` | The settings tab. `app/components/BoardImportOptions.vue` holds the options both tabs share. |
| `app/components/TicketEditor.vue`, `TicketCard.vue` | The **Jira issue** panel and the issue-key badge. |

## Surfaces

- **Internal routes:** `server/api/boards/[id]/jira/token.post.ts`, `token.delete.ts`, `test-connection.post.ts`; `server/api/import/run.post.ts` and `latest.get.ts` take `provider`.
- **REST v1:** `GET /boards/{boardId}/import?provider=jira` (last run), `POST /boards/{boardId}/import` with `{ "provider": "jira" }` (run a sync). Without `provider` both mean TestFlight, as before. Credentials are not on the public surface.
- **MCP:** no new tools. `get_ticket` returns the `jira` block with the ticket.
- **Webhooks:** `import.completed`, whose `run` carries `provider`.

## Tests

- `tests/adf.test.ts`: the ADF conversion, node by node.
- `tests/jira-policy.test.ts`: site normalisation, priority mapping, the description with comments.
- `tests/jira.test.ts`: the auth header, site pinning, error texts, and a sync against a mocked Jira with two pages.
- `tests/db.test.ts`: the credential migration off `boards`, a Jira ticket's insert and hydration, the widened `source` check.
- `tests/operations.test.ts`: who may store a token and run a sync, and what an incomplete connection reports.

## Configuration

| Variable | Purpose |
|---|---|
| `BUGSTER_SECRET_KEY` | Encrypts the stored API tokens, as it does the TestFlight keys. See [app-store-connect.md](app-store-connect.md#configuration). |

Jira Data Center and Server are not supported: they authenticate with personal access tokens and may live under a path, and the sync speaks Jira Cloud's v3 search.
