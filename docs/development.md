# Development

Running Open-Bugster locally, the test suite, the scratch instance, and the checklist a new feature has to satisfy before it fits the codebase.

## Running locally

Requirements: Node.js 22 or newer.

```bash
npm install
cp .env.example .env
```

Fill in the `APP_ADMIN_*` variables as described in [setup.md](setup.md#configuring-through-env-instead); the machine secrets generate themselves here too, into `secrets.json` next to the database. The paths in the example point at the Docker container, so set local ones instead:

```dotenv
DATABASE_PATH=./data/local/open-bugster.sqlite
ATTACHMENTS_PATH=./data/local/attachments
```

```bash
npm run dev
```

The directories, the SQLite file, and a default board are created automatically. `data`, `.env`, and `secrets` are excluded from Git and must not be committed. A board works without App Store Connect credentials; the sync then reports a clear configuration error.

Any number of data sets can live side by side; switching is a matter of pointing both paths at another directory while the dev server is stopped. To work with a copy of the Docker data, stop the container first so the SQLite file, its WAL, and the attachments form a consistent snapshot:

```bash
docker compose stop bugster
mkdir -p data/real
docker compose cp bugster:/data/. data/real/
```

The copy is an independent data set from that point on and is never written back to the volume.

### The scratch instance

`.claude/launch.json` defines two dev servers: `bugster` on port 3000 against the configured `.env`, and `bugster-scratch` on port 3100 against a throwaway database under `data/tmp/` with a seeded owner (`owner@example.com`). Use the scratch one for end-to-end checks that should not touch real data.

## Quality assurance

```bash
npm test            # vitest, tests/*.test.ts
npm run typecheck   # nuxt typecheck (vue-tsc)
npm run build
```

Tests run against throwaway SQLite databases and need no running server. `npm run test:watch` keeps them running.

## Adding a feature

The codebase is built so that a feature cannot land halfway: a new concept reaches the web UI, the REST API, and the MCP tools through one operation, and the guards described in [architecture.md](architecture.md) turn a forgotten step into a compile or test failure. The order that works:

1. **Schema and migration** in `server/utils/db.ts`. Add DDL to the schema literal for new tables, and an idempotent `ensure*` function that sniffs the schema before changing anything. Append it to the ordered list in `getDb()` after everything it depends on. Add the data functions next to their family.
2. **Shared type and Zod twin.** The type in `shared/types/domain.ts`, the schema in `shared/schemas/domain.ts`, an entry in the `SchemasMatchDomain` tuple, and a registration in the `named` map if the REST API will publish it. The compile guard makes forgetting any of these an error.
3. **Input schema** in `server/utils/validation.ts`.
4. **Operation** with `defineOperation` in the fitting module under `server/operations/`, or a new module registered in `operations/index.ts`. Pick the `requires` scope and role, and write the `audit` spec with an explicit `changes` allowlist. A read may declare `audit: false` only if its name ends in `.list`, `.get…`, `.activity`, `.status`, `.candidates`, or `.deliveries`; the test in `tests/operations.test.ts` enforces this.
5. **Internal route** under `server/api/`: three lines, `run(op, sessionActor(event), input)`.
6. **REST v1 route** in `server/api/v1/routes.ts`, only if the feature belongs on the public surface. Instance administration and credentials stay off it, and a test checks that.
7. **MCP**, only if the feature changes what an agent would ask for. Prefer reshaping an existing tool over adding one; the tool count is capped at 14, every tool needs honest annotations, and no tool may be named after an operation. See [mcp-server.md](mcp-server.md).
8. **Webhook event**, if other systems should hear about it: one line in `eventForOperation` and one entry in `shared/utils/webhook-catalogue.ts`; the test holds them together.
9. **UI**: state in a composable if it is shared, a component or settings section, and the header if it needs an entry point.
10. **Tests** for the migration (fresh and pre-existing database), the data layer, and the access rule. The registry-shape suites pick a new operation up automatically.
11. **Documentation**: the feature's document under `docs/`, following the section order in [docs/README.md](README.md), and a line in the README feature list if it is user-visible.

Rules that hold across all of it:

- Nothing mutates data except through an operation.
- Authorization reads the `Actor`, never the request.
- Unknown or invisible things answer 404, not 403.
- Ticket numbers stay instance-global.
- Secrets never enter the audit log; the `changes` allowlist is the mechanism.
- Migrations only run forward and are idempotent.

## Code map

| Path | What it is |
|---|---|
| `nuxt.config.ts` | Nuxt 4 configuration, Tailwind via the Vite plugin, the auth module. |
| `vitest.config.ts` | Test configuration. |
| `tsconfig.json` | Extends the Nuxt-generated config. |
| `package.json` | Scripts and dependencies: Nuxt 4, better-sqlite3, zod 4, nuxt-auth-utils, reka-ui, Tailwind 4, `@modelcontextprotocol/sdk`, jose, `@lucide/vue`. |
| `.claude/launch.json` | The two dev server definitions. |
| `tests/` | One file per area; see the table in [architecture.md](architecture.md#tests). |
| `backlog/` | Planning notes and implementation logs. Not documentation. |
