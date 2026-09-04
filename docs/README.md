# Open-Bugster documentation

One document per feature, each written for two readers at once: a person who wants to know what the feature does and how to use it, and an agent that needs to find and understand the code behind it quickly. Every document follows the same order, so you can jump straight to the part you need:

1. **Summary** – what the feature is and why it exists.
2. **Using it** – the behaviour as seen in the browser, with the UI paths.
3. **How it works** – the rules and invariants the code enforces.
4. **Code map** – which files hold what, with operation names and key functions.
5. **Surfaces** – the internal routes, REST v1 routes, MCP tools, and webhook events that touch it.
6. **Tests** – which test files cover it and which tests guard an invariant.
7. **Configuration** – environment variables, where the feature has any.

Line numbers in code maps are approximate and refer to the state of the code when the document was last revised. Search for the named function rather than trusting the number.

## Where to start

- **Operating an instance:** [setup.md](setup.md), then [backups-and-updates.md](backups-and-updates.md).
- **Using the board:** [boards.md](boards.md), [tickets.md](tickets.md), [users-and-access.md](users-and-access.md).
- **Connecting other software:** [api.md](api.md), [mcp-server.md](mcp-server.md), [webhooks.md](webhooks.md); the built-in imports are [app-store-connect.md](app-store-connect.md) and [jira.md](jira.md).
- **Reading or changing the code:** [architecture.md](architecture.md) first, then [development.md](development.md) for the checklist a new feature has to satisfy.

## Documents

| Document | Covers |
|---|---|
| [architecture.md](architecture.md) | The shared core every surface runs on: operations, the actor, access rules, the SQLite data layer and its migrations, the frontend layout, and the tests that guard the invariants. |
| [setup.md](setup.md) | Installing with Docker, the `.env` file, the machine secrets, HTTPS, where data lives, and what to do when nobody can sign in. |
| [backups-and-updates.md](backups-and-updates.md) | The three host-side scripts, what survives an update, and why migrations only run forward. |
| [development.md](development.md) | Running locally, the test suite, the scratch instance, and the checklist for adding a feature. |
| [workspaces.md](workspaces.md) | The level above boards: grouping, workspace administrators, board order, moving and duplicating boards. |
| [boards.md](boards.md) | Boards, lanes and the import lane, categories, labels. |
| [tickets.md](tickets.md) | Tickets, to-dos, attachments, comments, history, assignment, archive, filtering and search. |
| [users-and-access.md](users-and-access.md) | Accounts, instance and board roles, invitations, password resets, disabling, anonymizing, deleting, and how identity by email works. |
| [api.md](api.md) | Tokens, the integration permission, service identities, the REST v1 API with OpenAPI, idempotency, and the audit trail. |
| [mcp-server.md](mcp-server.md) | The MCP endpoint for AI agents: the tools, their annotations, the two permission layers. |
| [webhooks.md](webhooks.md) | Outgoing signed webhooks: events, signing, retries, destination screening. |
| [app-store-connect.md](app-store-connect.md) | The built-in TestFlight import: credentials, encryption, the sync, and upgrading from a single board. |
| [jira.md](jira.md) | The built-in Jira Cloud import: API token and JQL per board, the one-way sync, descriptions from ADF, attachments. |
