# Ctrl-5 — Waypoint (Tech Triathlon 2026)

Delivery planning and operations platform for Waypoint's Store Managers, Dispatchers, Loaders and Drivers.
Architecture: [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md). Requirements: [docs/SRS.md](docs/SRS.md).

## Repository layout

```
apps/
  web/          React 18 + Vite PWA (all four roles)
  api/          Fastify 5 API (routes -> service -> repo)
packages/
  shared/       Zod schemas, enums, DTOs, error codes
  planning/     Pure, deterministic planning engine (imports @waypoint/shared only)
  database/     Drizzle schema, migrations and seed
infra/          Dockerfiles and Caddyfile
e2e/            Playwright end-to-end tests
docs/           Architecture, requirements and design reference
data/           Confidential competition CSVs (gitignored, never committed)
```

## Prerequisites

- Node 22.18 or newer (`.nvmrc`)
- pnpm via Corepack: `corepack enable pnpm`
- Docker with Compose v2

## Source data

The competition datasets are confidential and are not in the repository. Place the supplied folders in `data/`
(`data/General Data/`, `data/Training Data/`, `data/Test Data/`, `data/Submission Templates/`). The folder is
gitignored and mounted read-only into the seed job.

## Local development

```bash
pnpm install
cp .env.example .env        # adjust POSTGRES_PORT / DATABASE_URL if 5432 is taken
pnpm db:up                  # Postgres 16 in Docker
pnpm db:migrate
pnpm db:seed
pnpm dev                    # API on :3000, web on :5173 (proxies /api)
```

If port 3000 is taken, start the API with `PORT=3100` and the web app with
`API_PROXY_TARGET=http://localhost:3100`.

Open http://localhost:5173. API docs: http://localhost:3000/api/docs.

## Full stack

```bash
docker compose up -d --build
```

Serves the web build and API through Caddy on `HTTP_PORT` (default 80). Set `DOMAIN` to a hostname for automatic HTTPS.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | API and web in watch mode |
| `pnpm build` | Build every workspace |
| `pnpm typecheck` | TypeScript strict check across all workspaces |
| `pnpm check` / `pnpm check:write` | Biome lint + format (check / fix) |
| `pnpm test` | Vitest unit and integration tests |
| `pnpm test:planning` | Planning engine tests only |
| `pnpm e2e` | Playwright (starts the web dev server unless `E2E_BASE_URL` is set) |
| `pnpm knip` | Unused files, exports and dependencies |
| `pnpm db:up` | Start Postgres 16 in Docker |
| `pnpm db:generate` | Generate a Drizzle migration from the schema |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:seed` | Seed the database |

Commits follow Conventional Commits with scopes `web`, `api`, `planning`, `shared`, `database`, `infra`, `docs`
(for example `feat(api): add health endpoint`), enforced by Husky and commitlint.

## Sign in and role workspaces

Open `/login` for every role. The account determines the workspace; there is no role selector.
The default seed password is `waypoint-demo` unless `SEED_PASSWORD` was set when the database was seeded.
An idempotent seed does not change existing passwords.

| Role | Email | Scope | Home route |
| --- | --- | --- | --- |
| Dispatcher | dispatcher@waypoint.test | Peliyagoda depot | /dispatcher |
| Loader | loader@waypoint.test | Peliyagoda depot | /loader |
| Driver | driver@waypoint.test | The reefer van kept available at Peliyagoda | /driver |
| Store Manager | store.manager@waypoint.test | A van-only Fresh outlet, so its chilled order rides the driver's van | /store |

With `DEMO_MODE=true`, startup sets the operating clock before the seeded service day’s cutoff so Store ordering remains usable. The seed report prints the actual vehicle/outlet assignments. Loader/Driver lists remain empty until a plan is published.
`/dispatch` redirects to `/dispatcher` for existing links.

## Walkthrough

One order from the store to a confirmed receipt, using the four accounts above. Start from a
fresh seed (Dispatcher → account menu "⋯" → Reset demo data).

1. **Store Manager.** Place order → Dry tab → add a few cartons → Submit. The chilled order for
   the same day is already open; both show as Submitted until the 16:00 cutoff.
2. **Dispatcher.** Account menu → After cutoff. Planning queue now holds the confirmed orders and
   the order deferred by the previous run.
3. **Dispatcher.** Allocation → Automatic → Run automatic allocation. Switch to Assisted and try a
   chilled order on a dry truck to see the validator refuse it.
4. **Dispatcher.** Deferrals → tick the order no vehicle can take → write the justification →
   Confirm. Review & publish → Publish.
5. **Loader** (tablet width). Open VEH035 → Start loading → Report shortfall → Send. Ready is
   blocked until the dispatcher answers.
6. **Dispatcher.** Live operations → open the shortfall → Apply.
7. **Loader.** Mark the stops loaded → Verify load → Confirm verification → Mark Ready.
8. **Dispatcher.** Account menu → Service morning.
9. **Driver** (phone width). Start trip → first stop → I've arrived → Record delivery → name,
   signature → Complete delivery.
10. **Driver, offline.** Switch the browser to offline, open the next stop, record the arrival and
    an outcome. The header shows the pending count. Go online again: Sync shows every event as
    Synced, and sending them twice changes nothing.
11. **Store Manager.** Receipts shows the driver's proof of delivery. Report an issue on a line,
    then Confirm receipt.
12. **Dispatcher.** Orders & audit → search the outlet → the order's full event log, from the
    cutoff to the receipt.

`E2E_BASE_URL=<url> E2E_REAL_STACK=true pnpm e2e` runs this walkthrough in a browser
(`e2e/tests/walkthrough.real.spec.ts`). It resets the demo data first.

See [the authentication audit and repair report](docs/AUTH_FLOW_REPAIR.md) for architecture, scope checks, tests, and offline limitations.
To verify the four real accounts, run `E2E_BASE_URL=http://localhost:8080 E2E_REAL_STACK=true pnpm e2e`
(adjust the URL for `HTTP_PORT`). Playwright loads `.env` for the seed password.
