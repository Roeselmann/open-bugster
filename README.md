<p align="center">
<img src="docs/images/screenshot-board.png">
</p>

# Open-Bugster

Open-Bugster is a lightweight, self-hosted Kanban board that is meant to be driven by other software as much as by people. It started as the shortest path from TestFlight feedback to a ticket — App Store Connect is still the one integration that ships built in — but everything the board can do is also a REST endpoint, an MCP tool, and an outgoing webhook, so any application, script, or AI agent can work the same board with the same permissions.

## Features

### A board first

- **Work as a team**  
  Real accounts with per-board roles, ticket assignment, comment threads, and a history on every ticket.
- **Run several boards**  
  Give every app or project its own board with its own lanes, categories, labels, and archive.
- **Group boards into workspaces**  
  A level above the boards for teams, clients, or departments — each workspace with its own boards, board order, and administrators. Boards can be moved or duplicated between workspaces.
- **Shape the workflow**  
  Add, rename, drag to reorder, and remove lanes per board—only the import lane is fixed.
- **Move tickets by dragging**  
  Drag cards between lanes and to any position within a lane.
- **Create tickets manually**  
  Capture ideas, tasks, and bugs with priority, due date, build number, and an internal comment.
- **Discuss in the ticket**  
  A comment thread per ticket instead of one shared note, with a history of moves, assignments and priority changes.
- **Organize with categories and labels**  
  One colored category per ticket, plus as many labels as needed. Labels are suggested while typing and created on the fly.
- **Filter and search**  
  Filter by labels, category, or assignee—including everything still unassigned—and search titles, descriptions, to-dos, authors, assignees, build numbers, and ticket numbers.
- **Attach files directly**  
  Add screenshots, documents, and other files to the relevant ticket.
- **Manage to-do lists**  
  Record the next steps within each ticket, reorder them, and work through them systematically.
- **Archive instead of delete**  
  Archived tickets stay restorable by a board administrator and are never re-imported.
- **Light and dark**  
  A theme toggle in the header, remembered per browser.

### Open to any application

- **Drive it from your own tools**  
  A versioned REST API at `/api/v1`, generated from the same definitions that validate the app itself, with a reference you can read in a browser and an OpenAPI document to generate a client from.
- **Connect AI agents**  
  An MCP endpoint lets Claude, Cursor, or anything else that speaks the protocol search a board, file tickets, and comment—reaching exactly as far as its token does, and recorded under the person or service it belongs to.
- **Push events to other systems**  
  Signed webhooks tell n8n, a chat channel, or a build pipeline when a ticket is created, updated, moved, archived, or restored, when somebody comments, and when an import finishes.
- **Give machines their own identity**  
  Scoped tokens, service identities for pipelines and jobs, and an audit trail that records which agent acted through which channel—so automation is accountable rather than anonymous.

### The integration that ships with it

- **Import TestFlight feedback**  
  Screenshots and crash reports land as tickets, with tester, device, system, build, and the original comment attached—per board, on that board's own App Store Connect credentials.

## The idea behind Open-Bugster

**It is a Kanban board first.** Several boards side by side, lanes you arrange yourself, and tickets with a priority, due date, assignee, labels, a category, a to-do list, attachments, and a comment thread—plus per-board roles so a team can share one instance, and an archive so nothing is ever really lost. None of that needs an Apple account, and a board that imports nothing never even shows an import lane. Used this way it is simply a small, self-hosted work tracker that a team can run for the cost of a container.

**App Store Connect is where it started.** For an iOS team the TestFlight import removes the most tedious part of beta testing: feedback arrives as tickets by itself, with the tester, device, system, locale, build, and the original screenshot or crash report already attached. Nothing gets copied out of App Store Connect by hand, and no device details are re-typed. Because people are matched by email address, a tester who is also on the team shows up as a colleague rather than as a string.

**Every other source connects through the API.** Rather than growing an integration per service, the board exposes itself: a versioned REST API, an MCP endpoint for AI agents, and signed outgoing webhooks. A crash reporter, a support inbox, a CI pipeline, an n8n flow, or an agent reading a codebase can all file, move, and comment on tickets—and the same email matching that turns a tester into a colleague works for whatever they bring in. Every entry point runs under the same roles as the browser does, and everything a token does is recorded against the person or service it belongs to, so opening the board to software does not mean opening it wider than a person would be.

**It is deliberately small.** It gives a useful workflow out of the box without trying to become an enterprise issue tracker: no sprints, no burndowns, no workflow engine. That is what makes it suitable for solo developers and small teams who want a practical process without meaningful setup, administration, or hosting costs.

**And it is a launchpad rather than a fixed product.** AI-assisted coding makes it easier than ever to read a compact codebase and bend it to a specific team. Add fields, change the workflow, connect other services, extend the permission model, or deploy it wherever you like.

## Setup

Open-Bugster is one container and one data volume. You need Docker on the machine that will host it; an App Store Connect API key is only needed for the TestFlight import.

1. **Get the code.**

   ```bash
   git clone https://github.com/Roeselmann/open-bugster.git
   cd open-bugster
   ```

2. **Start it, saying who the first account is.** The email becomes your sign-in name and the owner of the instance; the password needs at least 12 characters.

   ```bash
   APP_ADMIN_EMAIL=ada@example.com APP_ADMIN_PASSWORD='a-long-password' docker compose up --build -d
   ```

3. **Sign in** at `http://<host>:3000` with that email and password, rename the default board, and invite your team from **Users** in the account menu.

The first start creates the database, the default board, the owner account, and the machine secrets, and the bootstrap variables are never read again. Everything beyond this—configuring through `.env`, managing the secrets yourself, HTTPS, where data lives, and what to do when nobody can sign in—is in [docs/setup.md](docs/setup.md). Connecting a board to TestFlight is in [docs/app-store-connect.md](docs/app-store-connect.md).

## Documentation

One document per feature, each written for people who want an overview and for agents that need to find the code fast. Start with [docs/README.md](docs/README.md).

| Document | Covers |
|---|---|
| [Architecture](docs/architecture.md) | The operation registry, the actor, access rules, the SQLite data layer, and the tests that guard them. The starting point for reading the code. |
| [Setup](docs/setup.md) | Docker, `.env`, secrets, HTTPS, data paths, recovering access. |
| [Backups and updates](docs/backups-and-updates.md) | The host-side scripts and why the backup is not optional. |
| [Development](docs/development.md) | Running locally, tests, and the checklist for adding a feature. |
| [Workspaces](docs/workspaces.md) | Grouping boards, workspace administrators, moving and duplicating boards. |
| [Boards](docs/boards.md) | Boards, lanes, the import lane, categories, labels. |
| [Tickets](docs/tickets.md) | Tickets, to-dos, attachments, comments, history, archive, filters. |
| [Users and access](docs/users-and-access.md) | Accounts, roles, invitations, resets, anonymizing, identity by email. |
| [API](docs/api.md) | Tokens, the integration permission, service identities, REST v1, the audit trail. |
| [MCP server](docs/mcp-server.md) | The tools for AI agents and their annotations. |
| [Webhooks](docs/webhooks.md) | Signed outgoing events, retries, destination screening. |
| [App Store Connect](docs/app-store-connect.md) | The TestFlight import, credentials, and encryption. |
