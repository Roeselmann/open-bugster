<p align="center">
<img src="docs/images/screenshot-board.png">
</p>

# Open-Bugster

Open-Bugster is a lightweight, self-hosted Kanban board that turns TestFlight feedback into actionable tickets—built for independent iOS developers and small teams, and easy to customize with AI-assisted coding.

## Features

- **Import TestFlight feedback**  
  Screenshots and crash reports land as tickets, with tester, device, system, build, and the original comment attached.
- **Run several boards**  
  Give every app its own board with its own lanes, categories, labels, archive, and App Store Connect credentials.
- **Shape the workflow**  
  Add, rename, drag to reorder, and remove lanes per board—only the import lane is fixed.
- **Move tickets by dragging**  
  Drag cards between lanes and to any position within a lane.
- **Create tickets manually**  
  Capture ideas, tasks, and bugs with priority, due date, build number, and an internal comment.
- **Organize with categories and labels**  
  One colored category per ticket, plus as many labels as needed. Labels are suggested while typing and created on the fly.
- **Filter and search**  
  Filter by labels or category, and search titles, descriptions, comments, to-dos, authors, build numbers, and ticket numbers.
- **Attach files directly**  
  Add screenshots, documents, and other files to the relevant ticket.
- **Manage to-do lists**  
  Record the next steps within each ticket, reorder them, and work through them systematically.
- **Archive instead of delete**  
  Archived tickets stay restorable and are never re-imported from TestFlight.
- **Light and dark**  
  A theme toggle in the header, remembered per browser.

## The idea behind Open-Bugster

Open-Bugster gives independent iOS developers and small teams a fast, simple, and affordable way to turn TestFlight feedback into an actionable ticket workflow. Instead of copying feedback by hand or adopting a large project-management platform, developers can import TestFlight reports into a focused Kanban board, add manual tickets, prioritize the work, and resolve issues together.

The application is intentionally small and straightforward. It provides a useful workflow out of the box without trying to become a complete enterprise issue tracker. This makes it suitable for solo developers and small teams that need a practical process without significant setup, administration, or hosting costs.

Open-Bugster is also intended as a launchpad rather than a fixed product. AI-assisted coding makes it easier than ever to understand and adapt a compact codebase to a team's specific needs. Developers can add fields, change the workflow, connect other services, introduce full multi-user accounts and permissions, or deploy the application on their preferred infrastructure.

## Working with the board

### Boards

Open-Bugster can run several boards side by side—typically one per app. The board name in the header becomes a dropdown as soon as a second board exists; the icon next to it opens the board settings. A newly created board is selected right away and opens its settings so lanes and credentials can be set up.

Each board owns its lanes, categories, labels, archive, and App Store Connect credentials. Deleting a board removes all of it, including attachments and the stored key.

### Lanes

Lanes are the columns of the board and are configured under **Board settings → Lanes**. Drag a lane by its handle to reorder it, or focus the handle and use the arrow keys. Top to bottom in the settings is left to right on the board.

Every board has exactly one canonical **import lane**, which is where TestFlight feedback lands. It can be renamed and reordered, but not deleted. It only appears on the board once something has actually been imported into it.

When a lane is deleted, its tickets are not lost: the dialog asks whether they should move to another lane or go to the archive.

<p align="center">
<img src="docs/images/screenshot-board-settings.png">
</p>

Each lane header carries a switch that shows or hides screenshot previews on its cards. The choice is remembered per lane and browser.

### Tickets

New tickets are created with **Add ticket** at the bottom of a lane, and land in that lane. A ticket holds a title, description, internal comment, priority, due date, build number, to-dos, attachments, one category, and any number of labels. Imported tickets additionally show the original TestFlight feedback with tester, device, system, locale, and build.

Cards are moved by dragging them between lanes or within a lane. On narrow screens each card offers a lane dropdown instead.

**Archive** removes a ticket from the board without losing it. Archived tickets stay restorable through the archive view in the header, and an archived TestFlight ticket is never imported again by a later sync.

### Categories

A ticket has at most one category. New categories are created from within a ticket by typing a name that does not exist yet.

Under **Board settings → Categories** each category can be renamed in place with the pencil icon and given one of eight color presets. The color is what the category pill uses on the cards and in the archive, so categories stay recognizable at a glance.

### Labels

Labels are a per-board list, edited directly in the ticket. The field suggests the board's existing labels while typing; a name that does not exist yet is offered as a new entry and created when the ticket is saved. Selected labels appear as pills and are removed with their × or with backspace.

Labels clean themselves up: when the last ticket that carried a label drops it, the label disappears from the board's list. A ticket can hold up to twelve labels of 30 characters each.

Next to the board search sits the same control as a filter. Picking several labels shows the tickets that carry **any** of them.

## App Store Connect

Importing TestFlight feedback requires an App Store Connect API key. Credentials are configured **in the app, per board**, so every board tracks its own app.

### What is needed

| Value | Where it comes from |
| --- | --- |
| **Issuer ID** | App Store Connect → Users and Access → Integrations → App Store Connect API |
| **Key ID** | Shown next to the generated key; it also appears in the downloaded filename, for example `AuthKey_ABC123DEFG.p8` |
| **Private key (`.p8`)** | Downloaded once when the key is created. Apple does not allow a second download—keep an encrypted backup |
| **App ID** | The numeric App Store Connect resource ID of the app, **not** its bundle ID |

The key needs at least the Developer, App Manager, or Admin role for the app.

### Entering them

Open **Board settings → TestFlight**, enter issuer ID, key ID, and app ID, upload the `.p8` exactly as downloaded, and save. The key is verified on upload and stored AES-256-GCM encrypted in the database; it is never written to disk and never sent back to the browser. It can be replaced or removed at any time, but never displayed again.

Set `BUGSTER_SECRET_KEY` in `.env` to a random 32-byte value **before** uploading a key:

```bash
openssl rand -base64 32
```

If it is left empty, the encryption key is derived from `NUXT_SESSION_PASSWORD` instead. That keeps existing installations working, but changing the session password then makes every stored `.p8` unreadable and the keys have to be uploaded again.

Never paste the key contents into `.env`, and never commit credentials or private keys.

### Test connection

**Test connection** asks Apple to resolve the configured app with the stored key and reports the app name and bundle ID it reached. It imports nothing and writes nothing, so it is safe to press at any time.

It checks the values currently **in the form**, saved or not—so a corrected key ID can be verified before storing it. Only the `.p8` always comes from the vault, because it never leaves the server. A note appears above the buttons while the form differs from what is stored.

### Sync

**TestFlight Sync** in the header imports everything that is not on the board yet. New tickets land in the import lane and carry a `TestFlight` label plus `Screenshot` or `Crash`; screenshots are attached as files.

**Submissions per sync** controls how far back a sync looks. Apple returns feedback newest first; each sync checks this many of the newest submissions per feedback type—screenshots and crashes counted separately. The default is 100. Raise it for a deeper first backfill, lower it to keep routine syncs cheap.

### Upgrading from a single board

Installations that configured TestFlight through the `ASC_ISSUER_ID`, `ASC_KEY_ID`, `ASC_APP_ID`, and `ASC_PRIVATE_KEY_PATH` variables keep working. On the first start after the upgrade, all existing tickets become a board named **Workboard** whose lanes match the previous columns, and those four values—including the `.p8` read from `ASC_PRIVATE_KEY_PATH`—are imported into it.

After that first start the variables are no longer read, and the `.p8` bind mount in `docker-compose.yml` can be removed. Verify the import under **Board settings → TestFlight** before deleting anything.

## How Open-Bugster stores data

Open-Bugster does not require a separate database server. All structured data is stored in a SQLite file, while uploaded and TestFlight-imported files are stored in a separate attachments directory.

| Setting | Purpose |
| --- | --- |
| `DATABASE_PATH` | Path to the SQLite file, for example `./data/real/open-bugster.sqlite` |
| `ATTACHMENTS_PATH` | Path to the corresponding attachments directory |

The two paths belong together—switch, copy, and back them up as one unit, and restart Open-Bugster after changing `.env`. Schema updates are applied automatically on start.

If the configured database does not exist, Open-Bugster creates it on first access. An empty application therefore does not necessarily mean that data was deleted: `DATABASE_PATH` often points to a different, newly created file.

Existing installations may continue to use a database file named `bugster.sqlite`; no rename is required.

## Docker

Run these commands on the Docker host, in the directory that contains `docker-compose.yml`.

1. Create the configuration and set a password:

   ```bash
   cp .env.example .env
   npm run password:hash -- "your-secure-password"
   ```

   Copy the generated `APP_PASSWORD_HASH` line into `.env` unchanged—the single quotes protect the `$` characters. Set `NUXT_SESSION_PASSWORD` to at least 32 random characters, and generate the encryption key for stored App Store Connect keys:

   ```bash
   openssl rand -base64 32
   ```

   ```dotenv
   BUGSTER_SECRET_KEY=the-generated-value
   ```

   Leave the `ASC_*` variables empty; they exist only to import an older single-board configuration. Keep the container paths `DATABASE_PATH=/data/open-bugster.sqlite` and `ATTACHMENTS_PATH=/data/attachments`.

2. Start Open-Bugster:

   ```bash
   docker compose up --build -d
   ```

3. Open `http://<host>:3000`, sign in, and set up the board under **Board settings → TestFlight** as described above. Then run **TestFlight Sync**.

Behind an HTTPS reverse proxy, set `NUXT_SESSION_COOKIE_SECURE=true` in `.env`.

Data lives in the named volume `bugster-data`, mounted at `/data`. It survives restarts, image rebuilds, and `docker compose down`—but not `docker compose down -v`. Back up the volume together with `.env`; without the original `BUGSTER_SECRET_KEY` the stored App Store Connect keys cannot be decrypted again.

## Local development

Requirements: Node.js 22 or newer.

```bash
npm install
cp .env.example .env
npm run password:hash -- "your-secure-password"
```

Copy the generated `APP_PASSWORD_HASH` line into `.env` without modifying it. The paths in `.env.example` point at the Docker container, so set local ones:

```dotenv
DATABASE_PATH=./data/local/open-bugster.sqlite
ATTACHMENTS_PATH=./data/local/attachments
```

```bash
npm run dev
```

The directories, the SQLite file, and a default board are created automatically. `data`, `.env`, and `secrets` are excluded from Git and must not be committed. A board works without App Store Connect credentials; the sync then reports a clear configuration error.

`APP_ADMIN_FIRST_NAME`, `APP_ADMIN_LAST_NAME`, and `APP_ADMIN_EMAIL` define the administrator identity. A fixed snapshot of it is stored as the author whenever a manual ticket is created.

Any number of data sets can live side by side—switching is a matter of pointing both paths at another directory while the dev server is stopped. To work with a copy of the Docker data, stop the container first so the SQLite file, its WAL, and the attachments form a consistent snapshot:

```bash
docker compose stop bugster
mkdir -p data/real
docker compose cp bugster:/data/. data/real/
```

The copy is an independent data set from that point on and is never written back to the volume.

## Quality assurance

```bash
npm test
npm run typecheck
npm run build
```

## API

Authentication

- `POST /api/auth/login`, `POST /api/auth/logout`

Boards, lanes, and credentials

- `GET /api/boards`, `POST /api/boards`
- `PATCH /api/boards/:id`, `DELETE /api/boards/:id`
- `POST /api/boards/:id/lanes`, `PATCH /api/boards/:id/lanes/:laneId`, `DELETE /api/boards/:id/lanes/:laneId`
- `PATCH /api/boards/:id/lane-order`
- `POST /api/boards/:id/key`, `DELETE /api/boards/:id/key`
- `POST /api/boards/:id/test-connection`

Tickets

- `GET /api/tickets`, `POST /api/tickets`
- `GET /api/tickets/:id`, `PATCH /api/tickets/:id`
- `PATCH /api/tickets/:id/position`
- `POST /api/tickets/:id/archive`, `POST /api/tickets/:id/restore`
- `POST /api/tickets/:id/attachments`
- `GET /api/attachments/:id`, `DELETE /api/attachments/:id`

Categories and labels

- `GET /api/categories`, `PATCH /api/categories/:id`, `DELETE /api/categories/:id`
- `GET /api/labels`

TestFlight

- `POST /api/import/testflight`, `GET /api/import/latest`
