# Waypoint Delivery Planning & Operations Platform

Team Ctrl-5 · Tech Triathlon 2026 · Hackathon submission

## Overview

Waypoint's stores order by phone and spreadsheet, the depot plans on paper, and nobody sees the
same picture of a delivery day. On a busy day there are more orders than vehicle capacity, and the
decisions about what is served and what waits are not recorded.

This platform puts the whole delivery day in one shared record, with a workspace for each role:

- **Store Manager** places orders before the 16:00 cutoff, tracks the delivery, confirms the
  receipt and reports discrepancies.
- **Dispatcher** plans the day: allocates confirmed orders to vehicle trips under hard
  constraints, defers what cannot be served with a recorded reason, publishes the plan and watches
  operations.
- **Loader** loads each vehicle in stop order, reports shortfalls and marks the vehicle ready.
- **Driver** runs the trip on a phone and records each stop and its proof of delivery, with or
  without a connection.

Requirements: [docs/SRS.md](docs/SRS.md).

## Live Demo

**https://ctrl-5-waypoint.onrender.com**

The service runs on a free plan and sleeps when idle, so the first request can take up to a minute.

| Role | Email | Password | Scope |
| --- | --- | --- | --- |
| Dispatcher | `dispatcher@waypoint.test` | `waypoint-demo` | Peliyagoda depot: planning and operations |
| Loader | `loader@waypoint.test` | `waypoint-demo` | Vehicles at the Peliyagoda depot |
| Driver | `driver@waypoint.test` | `waypoint-demo` | Trips of one vehicle (VEH035, a reefer van) |
| Store Manager | `store.manager@waypoint.test` | `waypoint-demo` | Orders and deliveries of one outlet (OUT001) |

Everyone signs in at `/login`; the account decides the workspace. These are demo accounts on
seeded demo data. To return to the starting state at any time, sign in as the Dispatcher and choose
account menu "⋯" → **Reset demo data**.

Every other vehicle at the depot also has a driver account, `driver.<vehicle id>@waypoint.test`
(for example `driver.veh012@waypoint.test`), with the same password. A driver sees only the trips
of their own vehicle.

## Key Capabilities

- **Order management.** Dry and chilled orders per outlet, editable until the 16:00 cutoff, then
  locked and confirmed for the next service day.
- **Planning and allocation.** One planning queue; automatic allocation that the dispatcher can
  review and change by hand before publishing.
- **Hard-constraint validation.** Weight, volume, refrigeration, van-only access, home depot,
  delivery and mall windows, weekly fuel quota and the two-trip limit. The same validator runs in
  the browser for instant feedback and on the server before anything is saved.
- **Deferral handling.** Orders that fit nowhere are deferred with a reason code and note; an
  order deferred by the previous run returns to the queue with its history and a higher priority.
- **Loading management.** Stops in reverse drop order, carton counts, shortfall, damage and
  missing-goods reports that the dispatcher must acknowledge, load verification, Ready.
- **Delivery and proof of delivery.** Arrival, delivered or failed with a reason, recipient name,
  signature and optional photo.
- **Offline-first driver workflow.** Trips are cached on the phone; every action is saved locally
  first and shown as pending.
- **Synchronisation and idempotency.** The outbox syncs on reconnect; each event has a
  client-generated id, so sending it twice changes nothing. Events for a stop that changed
  meanwhile are kept as sync conflicts.
- **Store receipt and discrepancies.** The store sees the proof of delivery, confirms the receipt
  and reports issues, which the dispatcher resolves.
- **Operations dashboard.** Live trip progress, exceptions and notifications over Server-Sent
  Events.
- **Audit trail.** Every change records actor, role, action, before and after.
- **Advanced features.** What-if simulation of a plan, replanning when a vehicle becomes
  unavailable after publish, plain-language explanations of why an order cannot go on a vehicle,
  plan quality metrics, and demand analytics from order history.

## Architecture

A modular monolith in TypeScript: a React PWA, a Fastify API and PostgreSQL, with the planning
rules in a pure package that both the API and the browser import. The hosted system is one Docker
container on Render (Caddy and the API) with a Neon PostgreSQL database.

- [docs/architecture.md](docs/architecture.md): components, diagrams, deployment, runtime flow
- [docs/data-model.md](docs/data-model.md): ER diagram and tables
- [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md): the full design document written before the build

## Repository Structure

```
apps/
  web/          React 18 + Vite PWA, all four role workspaces
  api/          Fastify 5 API (routes -> service -> repo per module)
packages/
  shared/       Zod schemas, enums, state machines, permissions, error codes
  planning/     Pure planning engine: validator, allocator, explanations
  database/     Drizzle schema, SQL migrations and seed
e2e/            Playwright browser tests
infra/          Dockerfiles, Caddyfiles
docs/           Architecture, data model, AI disclosure, requirements, demo script
data/           Competition CSVs (gitignored, never committed)
docker-compose.yml   Local stack: db, migrate + seed, api, web
render.yaml          Hosted deployment
.env.example         Environment template
```

A pnpm workspace (`pnpm-workspace.yaml`) links the apps and packages.

## Local Setup

Prerequisite: Docker with Compose v2.

```bash
git clone <repository-url>
cd <repository-folder>
cp .env.example .env
docker compose up --build
```

Then open **http://localhost** and sign in with the accounts under [Live Demo](#live-demo).

`docker compose up` starts four services in order: PostgreSQL, a one-shot job that runs the
migrations and the seed, the API, and Caddy with the web build. The seed prints the four accounts
and the password in the `migrate` log. A second start keeps the existing data.

- **Port 80 in use?** Set `HTTP_PORT` (and `HTTPS_PORT`) in `.env`, for example `HTTP_PORT=8080`,
  and open http://localhost:8080.
- **Seed data.** The competition datasets are confidential and not in the repository. Without
  them the seed builds a small synthetic delivery day, so the stack starts from a fresh clone; the
  demo driver is then on VEH001. To seed from the real data, place the supplied folders in `data/`
  (`General Data/`, `Training Data/`, `Test Data/`, `Submission Templates/`) before the first start.
  The hosted system is seeded from the real data.
- **Start again from empty.** `docker compose down -v` removes the database volume.

### Environment configuration

`.env.example` lists every variable with a placeholder value; the defaults work locally as they are.

| Variable | Purpose |
| --- | --- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Local database |
| `DATABASE_URL` | Used by `pnpm dev`, `db:migrate` and `db:seed` on the host; the containers override it |
| `SESSION_SECRET` | Cookie signing, at least 32 characters. Replace it in any shared environment |
| `DOMAIN` | Caddy site address: `http://localhost`, or a hostname for automatic HTTPS |
| `HTTP_PORT`, `HTTPS_PORT` | Host ports of the web container |
| `DEMO_MODE` | Enables the demo clock and Reset demo data |
| `DEMO_DATE` | Optional initial operating date |
| `LOGIN_RATE_LIMIT` | Optional sign-in attempts per address per minute (default 10) |
| `DATA_DIR` | Where the seed reads the CSVs |
| `SEED_PASSWORD` | Optional password for the seeded accounts (default `waypoint-demo`) |
| `LOG_LEVEL` | API log level |

## Manual Development Setup

Prerequisites: Node 22.18 or newer (`.nvmrc`), pnpm through Corepack (`corepack enable pnpm`),
Docker for the database.

```bash
pnpm install
cp .env.example .env        # adjust POSTGRES_PORT / DATABASE_URL if 5432 is taken
pnpm db:up                  # PostgreSQL 16 in Docker
pnpm db:migrate
pnpm db:seed
pnpm dev                    # API on :3000, web on :5173 (proxies /api)
```

Open http://localhost:5173. API docs: http://localhost:3000/api/docs. If port 3000 is taken, start
the API with `PORT=3100` and the web app with `API_PROXY_TARGET=http://localhost:3100`.

## Testing

| Command | What it runs |
| --- | --- |
| `pnpm check` | Biome lint and format check (`pnpm check:write` fixes) |
| `pnpm typecheck` | Strict TypeScript across all workspaces |
| `pnpm test` | Vitest unit and integration tests (needs the database: `pnpm db:up`) |
| `pnpm test:planning` | Planning engine tests only (no database) |
| `pnpm e2e` | Playwright browser tests against the dev server with mocked API |
| `pnpm build` | Build every workspace |
| `pnpm knip` | Unused files, exports and dependencies |

With a seeded stack running, `E2E_BASE_URL=<url> E2E_REAL_STACK=true pnpm e2e` also runs the
real-stack specs: the judge walkthrough below (`walkthrough.real.spec.ts`), the post-publish
operations (`operations.real.spec.ts`) and the role checks (`roles.real.spec.ts`). They reset the
demo data and sign in many times a minute, so start that stack with `LOGIN_RATE_LIMIT=500`.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs lint, typecheck, Knip, tests, build
and the browser tests on every push. Commits follow Conventional Commits, enforced by Husky and
commitlint.

## Judge Walkthrough

One order from the store to a confirmed receipt, across all four roles, on the live demo. It takes
about ten minutes. Keep one browser window per role (separate profiles or private windows), and
use tablet width for the Loader and phone width for the Driver.

The demo runs on an operating clock that the Dispatcher controls, so the 16:00 cutoff and the
service morning can be reached without waiting.

**Before you start.** Sign in as the Dispatcher → account menu "⋯" → **Reset demo data**. The
clock is now shortly before the 16:00 cutoff. The clock moves only when the Dispatcher moves it,
and it keeps its place if the hosted service restarts.

**Step 1 — Store Manager: place an order**

1. Sign in as the Store Manager. The home page shows the outlet's current orders; the chilled
   order for the next service day is already open.
2. Place order → Dry tab → add a few cartons → Submit. Both orders show as Submitted and stay
   editable until the 16:00 cutoff.

**Step 2 — Dispatcher: plan and publish**

3. Before the cutoff the store's two orders are still editable, so they are not in the planning
   queue yet. A notice at the top of every Dispatcher page says how many are waiting, and Review
   & publish stays off. Press **Close orders now (demo clock)** on that notice (or account menu →
   **After cutoff**). The orders lock and become Confirmed. The planning queue now holds the
   confirmed orders and an order deferred by the previous run, marked with its history.
4. Allocation → Automatic → **Run automatic allocation**. Each vehicle lane shows its weight and
   volume use.
5. Switch to Assisted and put a chilled order on a dry truck. The validator refuses it and states
   the rule that failed.
6. Deferrals → tick the order no vehicle can take → write the justification → Confirm.
7. Review & publish → **Publish**. The loader, the drivers and the stores are notified.

**Step 3 — Loader: load the vehicle** (tablet width)

8. Sign in as the Loader and open VEH035. The stops are listed in loading order, last drop first.
9. Start loading → Report shortfall → Send. Ready is blocked until the dispatcher answers.
10. *Dispatcher:* Live operations → open the shortfall → Apply.
11. *Loader:* mark the stops loaded → Verify load → Confirm verification → **Mark Ready**.

**Step 4 — Driver: deliver, then deliver offline** (phone width)

12. *Dispatcher:* account menu → **Service morning**.
13. Sign in as the Driver. Start trip → first stop → I've arrived → Record delivery → recipient
    name and signature → Complete delivery.
14. Switch the browser to offline (DevTools → Network → Offline). The offline bar appears. Open
    the next stop and record the arrival and an outcome; the header shows the pending count.
15. Go online again. The Sync page shows every event as Synced; sending them twice changes nothing.

**Step 5 — Store Manager: confirm the receipt**

16. Receipts shows the delivery status and the driver's proof of delivery. Report an issue on a
    line, then **Confirm receipt**.

**Step 6 — Dispatcher: close the loop**

17. Live operations shows the completed stops; Store issues shows the store's report. Write what
    was decided → Resolve issue.
18. Orders & audit → search the outlet → the order's full event log, from the cutoff to the receipt.

**Optional — after the plan is published**

- **A vehicle breaks down.** Fleet & trips → pick a vehicle → Mark unavailable. Its trips that
  have not departed stop, and the replan page proposes a trip for each order that passes every
  hard rule, or a deferral naming the rule that blocks it. Publish sends the next plan version to
  the loader, the affected drivers and the stores. Trips already on the road never change.
- **One order moves or is deferred.** Fleet & trips → Change on a stop → another vehicle and
  trip, or Defer to next run with a reason.
- **An empty plan cannot be published.** Review & publish stays off, and the API refuses it,
  until orders are on trips or each one has been deferred with a reason.
- **A plan cannot be published before the cutoff** while stores still have submitted orders for
  that run: they would be left out. The check on Review & publish names how many are waiting.

## Designathon Departures

The build follows the Designathon Figma design ([CTRL+5.fig](CTRL+5.fig)) screen by screen. The
significant differences are below. The first group changes what a user sees; the second changes
the technical plan in [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md).

| Area | Designathon | Final implementation | Reason |
| --- | --- | --- | --- |
| Demo controls | Not in the design | Dispatcher account menu has a demo clock (After cutoff, Service morning), a service-date field and Reset demo data. While orders for the run are still open, a notice on every Dispatcher page says so and carries the same cutoff control | A judge must be able to reach the cutoff and the delivery morning without waiting, and start again |
| Dispatcher controls | Frames show one vehicle, one order, no confirmation | Added a vehicle picker and Trip record button, order search and picker, and confirm dialogs before publishing | The frames could not reach other records, and publishing is not reversible |
| Store Manager navigation | Deliveries and Receipts show one delivery | Added an order picker in the page header and order search | An outlet has more than one order |
| Driver on wide screens | Phone frames only | The phone layout is centred on wider screens; no desktop layout | The driver works on a phone |
| Hosting | One VPS running Docker Compose with Caddy HTTPS | One container on Render, database on Neon | Free managed hosting that stays up for the evaluation period; Compose is unchanged for local use |
| Web libraries | TanStack Router, Tailwind with shadcn/ui, Zustand, React Hook Form, Recharts | React Router, plain CSS with design tokens, a small set of Radix primitives, TanStack Query | Fewer dependencies; the design tokens map directly to CSS variables |

No workflow, role or business rule departs from the design.

## Known Limitations / Competition Scope

- **Datathon models are not integrated.** Analytics use order history, and service times use the
  supplied allowances. The booklet allows the Datathon to be a separate solution.
- **No live GPS.** ETA is the planned arrival, shifted by recorded stop events.
- **Offline needs one online start.** The driver must sign in and open the trip while online;
  after that the app reloads and works without a connection. There is no offline sign-in.
- **Sync conflicts are recorded, not resolved in the app.** The driver and the dispatcher see the
  conflict; there is no dispatcher action to resolve it.
- **Orders are not split across vehicles**, and stops are sequenced by district travel times, not
  by a full route optimiser.
- **Notifications are in-app only** (no SMS or push).
- **Demo mode.** The hosted system runs with `DEMO_MODE=true` so the clock and reset are
  available; a production deployment would turn it off.
- **Dates.** The supplied calendar ends on 28 June 2026. Later operating days (Monday to Saturday)
  are generated ahead of the operating clock, so the demo works on any later date.

## AI Tool Disclosure

See [docs/AI_DISCLOSURE.md](docs/AI_DISCLOSURE.md).
