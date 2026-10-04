# UI implementation guide

How we build the Waypoint front end from the submitted Figma file, one role at a time. Read §1–§5
before you start a page. §6 onward is reference: the frame lists, the Dispatcher status, where each
Dispatcher page gets its data, open questions and how to check each Dispatcher page.

Figma file: `LXaIkpyGMshfrqYe50jRDN`, page "03 · Screens · Soft Bento" (node `2012:181`).

## 1. Rules

1. **Figma is read-only.** It is the submitted file. Never edit it, and never use a Figma tool that
   writes. If the design is unclear or looks wrong, record it in §9 and ask.
2. **Figma decides how a page looks. The existing app decides how it works.** Keep working API
   calls, sign-in and business logic. Do not redesign a screen, and do not rewrite working logic.
3. **Backend, API contracts and database schema are not ours to change** in this work. If the API
   does not return something a frame shows, fill the gap with a frontend fixture and log it (§8).
4. **Pages never know where data comes from.** A page asks the role's data layer for a path and
   parses the answer with a contract. The data layer answers from the real API where it can and
   from a fixture where it cannot (§3). No fixture data inside a page component.
5. **Use Figma's values.** Sizes, spacing, type and colour come from the frame, expressed through
   the tokens in `apps/web/src/styles/tokens.css`. No raw colours.
6. **Do not change another role's look.** Shared components in `components/waypoint` may gain new,
   optional props and new components. A change that alters how an existing component looks must be
   scoped to your role (see the Dispatcher shell in §5).
7. **Status never relies on colour alone.** Use `StatusBadge` and `Tag` (icon + label).
8. **Times render in Asia/Colombo** through `lib/format.ts` (`shortDay`, `clock`).
9. **Check before you hand over.** Biome (`pnpm check`) and TypeScript (`pnpm typecheck`) must pass
   for your files. We do not run screenshot or browser automation; the page owner reviews by eye.
10. **Several sessions work in this folder at once.** Stay inside `features/<your role>/`. Read a
    shared file again just before you edit it, and keep the edit small.
11. The existing rules in `.cursor/rules/` still apply (TypeScript strict, no new libraries without
    a reason, Conventional Commits).

## 2. Running the app

| Command | Dispatcher data | Needs |
| --- | --- | --- |
| `pnpm dev` | Real API, with fixtures for the gaps in §8 | Postgres running, `pnpm db:migrate`, `pnpm db:seed` |
| `VITE_DISPATCH_FIXTURES=all pnpm dev` | Every Dispatcher page shows the Figma scenario | The same; sign-in is still real |

Both serve the web app on http://localhost:5173. Sign in with a demo account; the password is
`waypoint-demo`.

| Role | Email | Workspace |
| --- | --- | --- |
| Dispatcher | dispatcher@waypoint.test | `/dispatcher` |
| Loader | loader@waypoint.test | `/loader` |
| Driver | driver@waypoint.test | `/driver` |
| Store manager | store.manager@waypoint.test | `/store` |

Sign-in, role routing (`RoleGuard` in `app.tsx`) and sign-out are shared and real in both modes.
Fixture changes (saved views, a published replan) last until the browser tab is refreshed. The
fixture clock starts at Fri 25 Sep 2026 17:05 (the Figma scenario).

## 3. The data layer (Dispatcher)

```
page  ──api(path, contract)──▶  features/dispatch/data/client.ts
                                   1. sources/   real API, mapped into the contract
                                   2. fixtures/  Figma data, for what the API cannot answer
                                   3. lib/api    the real API as it is, for every other path
```

```
apps/web/src/features/dispatch/
  contracts.ts        what each page needs from one request (zod), named after its endpoint
  data/client.ts      api(): tries a source, then a fixture, then the real API
  data/context.ts     the signed-in dispatcher, the run date and the operating clock
  data/sources/       plan.ts (loads one run from the real API), planning.ts, dashboard.ts
  data/fixtures/      one file per page group, copied from the Figma frames
  engine.ts           the planning package's validator, used for placements (kept from main)
```

- A page imports `api` from `./data/client`, never from `lib/api`.
- A **source** is `[method, path, handler]`. The handler calls the real API through `lib/api`,
  maps the answer into the contract, and may throw `HttpError`. Writes call `forgetPlans()`.
- A **fixture** route has the same shape and returns plain JSON. Type it with the contract's
  inferred type, copy the values from the Figma frame, and name the frame in a comment.
- When the server gains an endpoint that serves a contract itself, delete its source and fixture.
  The page does not change.
- Fixtures load on demand (a separate chunk), and only for paths no source answers.

Other roles can copy this layout into `features/<role>/data/`.

## 4. Building a page

1. Find the frame in §6 and fetch it once with the Figma MCP `get_design_context` tool, passing the
   frame's node id. Fetch the frame, never the whole page or section: section A alone is 3.4 MB.
2. Check what already exists: `components/waypoint` (shared), `features/<role>/`, and the icons in
   `apps/web/public/waypoint`.
3. Write the contract. Reuse a `@waypoint/shared` schema when an existing endpoint covers the
   frame. Otherwise add a schema to `features/<role>/contracts.ts`.
4. Feed it: a source if the real API has the data, a fixture if it does not. Log gaps in §8.
5. Build the page. Lay it out with flex and grid, not the absolute positions in the Figma output.
6. Icons: use `<Icon name="truck" />`. One SVG per Figma icon lives in
   `public/waypoint/icons/<name>.svg` and is tinted by the text colour. For a new icon, download it
   from the Figma asset URL, save it under its Figma name, and add a `<title>` as the first child
   (Biome requires it). Do not redraw or recolour them.
7. Styles: one CSS file per page, imported by that page, with a short class prefix (`dq-` queue,
   `ou-` outlets…). Classes shared by a role's pages go in the role's main CSS file (`d-*` for
   Dispatcher). Give an element its own class instead of a nested tag selector such as
   `.card strong`; Biome's `noDescendingSpecificity` rule fails on those.
8. Tablet and phone: change the layout with media queries in the page's CSS. Use `useMedia` from
   `lib/use-media.ts` only when the markup itself must differ (D09 on a phone).
9. Run Biome and TypeScript, then update the status in §7 (or your role's list).

## 5. Shared layer

Import from `apps/web/src/components/waypoint`. Preview at `/dev/design-system`.

| Piece | Use |
| --- | --- |
| `AppShell`, `TopBar` | The earlier shared web shell. No role uses it now: Dispatcher and Store each have a Figma shell of their own (§5, §11). |
| `PageHeader` | Page title, subtitle and the actions on the right. `inShell` hides the title on tablet and phone, where the top bar shows it. |
| `Icon`, `MaskIcon` | Single-colour icon tinted by the text colour |
| `IconButton`, `Popover` | Round icon button, and one that opens a small panel |
| `Tabs`, `SegmentedControl`, `Dropdown`, `Chip` | Choosing a view, a value or a filter |
| `Checkbox`, `Switch`, `Field`, `TextArea` | Form controls. `Field locked` is the read-only field with a lock. |
| `Overlay` | Right-hand drawer or centred modal, with focus kept inside |
| `Banner` | In-page message: what happened, the consequence, the next step |
| `ProgressBar`, `Ring`, `HistoryDots`, `DeltaBadge`, `Avatar` | Small data pieces |
| `Card`, `MetricCard`, `ActionList`, `Tag`, `StatusBadge`, `DataTable`, states, skeletons | Existing library |
| `Button size="md"` | The 40px desktop button from page headers (default stays 44px) |

Helpers: `lib/format.ts` (`shortDay`, `clock`, `weekDay`), `lib/csv.ts` (`downloadCsv`),
`lib/use-media.ts` (`useMedia`).

What the Dispatcher work added to shared files (all additive; nothing else looks different):

- New files: `controls.tsx` + `controls.css`, `primitives.tsx`, the three `lib/` helpers, and the
  icon folders `public/waypoint/icons`, `shell`, `dispatch`.
- New optional props: `Button size`, `Badge className`, `MetricCard badge` and `iconTone`.
  `StatusBadge` and `Tag` now carry the classes `wp-status` and `wp-tag`.
- New tokens in `tokens.css`: `--color-action-selected`, `--font-mono`,
  `--color-data-accent-soft`, `--color-data-cat-1…4`, `--color-data-neg-soft`.
- New dependency in `apps/web`: `zod` (page contracts). It was already in the workspace catalog.

**The Figma shell is Dispatcher-only.** `features/dispatch/shell.tsx` is the Figma sidebar
(`2034:673`) and top bar (`2034:768`) with the tablet icon rail and the phone tab bar.
`features/dispatch/shell.css` holds every style that changes an existing shared class (shell,
badges, action rows). Each rule is scoped by `html[data-workspace="dispatch"]`, which the
Dispatcher workspace sets while it is mounted. Store, Loader and Driver keep the shared look. If
the Figma shell should become the shell for every web role, move these two files into
`components/waypoint` and drop the scope.

## 6. Frame inventory

Node ids are for `get_design_context`. Sections F–I are the clickable prototypes: use them to see
the states and the order of a flow, not as extra pages.

### A · Dispatcher · web (`2036:496`) — see §7 for status

### B · Loader · tablet 1180×820 (`2036:497`)

| Frame | Node | Frame | Node |
| --- | --- | --- | --- |
| L01 Assigned loads | `2045:4759` | L04a Shortfall sent | `2045:5502` |
| L02 Loading plan | `2045:4929` | L05 Plan changed | `2045:5641` |
| L03 Verification | `2045:5150` | L06 Ready | `2045:5803` |
| L04 Report shortfall | `2045:5323` | L07 Switch user | `2106:9679` |

Prototype: section G (`2140:17884`), 41 frames, guide `2152:21546`.

### C · Driver · phone 390×844 (`2036:498`)

| Frame | Node | Frame | Node |
| --- | --- | --- | --- |
| DR01 My trips | `2046:4816` | DR05a Saved offline | `2046:5641` |
| DR02 Trip overview | `2046:5122` | DR05b Sync center | `2046:5705` |
| DR03 Stop detail | `2046:5243` | DR05c Reconnected | `2046:5840` |
| DR04 Outcome & POD | `2046:5462` | DR05d Conflict | `2046:6036` |
| DR04a Failed delivery | `2046:5550` | DR06 Route change | `2046:4727` |
| DR05 Offline mode | `2046:5341` | DR07 Notices | `2106:10655` |
| DR08 Account | `2106:10764` | | |

Prototype: section H (`2158:21580`), 44 frames, guide `2162:23935`. Routes, status and backend gaps: §11.

### D · Store Manager · web 1440 + phone 390 (`2036:499`) — see §11 for status

| Frame | Node | Frame | Node |
| --- | --- | --- | --- |
| S01 Store home | `2047:5268` | S01m Store home · phone | `2048:6473` |
| S02 Place order | `2047:6039` | S02m Place order · phone | `2106:10922` |
| S02a Cutoff passed | `2047:6406` | S03m Confirmation · phone | `2106:11076` |
| S03 Order confirmation | `2047:6626` | S04m Tracking · phone | `2048:6583` |
| S04 Tracking & ETA | `2048:5829` | S05 Deferral notice · phone | `2048:6691` |
| S05-W Deferral notice | `2102:7487` | S06 Confirm receipt · phone | `2048:6817` |
| S06-W Confirm receipt | `2102:7769` | S06a Receipt with issue · phone | `2048:6921` |
| S07 Issues | `2048:6257` | S07m Issues · phone | `2106:11180` |

Prototype: section I (`2174:23663`), 59 frames, guide `2186:29764`.

### E · Shared · all roles (`2036:500`) — see §9

| Frame | Node |
| --- | --- |
| X01 Sign in & role routing | `2048:7046` (phone `2048:7290`) |
| X02 Notification center | `2048:7369` |
| X03 System states | `2048:7666` |
| X04 Global search ⌘K | `2106:8244` |
| X05 Profile & switch user | `2106:8641` |

## 7. Dispatcher status

Every frame of section A is built on `main`, at `/dispatcher`, inside the real sign-in, the live
event stream, the notification feed and the demo clock.

| Frame | Node | Route | Data |
| --- | --- | --- | --- |
| D01 Command center | `2037:496` | `/dispatcher` | Real API |
| D01 operations view | `2128:17913` (prototype P34) | `/dispatcher?view=operations` | Real API |
| D02 Planning queue | `2038:1628` | `/dispatcher/queue` | Real API |
| D02a Saved views | `2106:9829` | drawer on the queue | Fixture |
| D03 Allocation + advisor | `2039:1075` | `/dispatcher/allocate` | Real API |
| D03a Automatic allocation result | `2106:11687` | state of allocation | Real API |
| D04 Fleet & trips | `2040:1447` | `/dispatcher/fleet`, `/dispatcher/vehicles/:vehicleId` | Real API |
| D04a Trip record · view only | `2106:11293` | `/dispatcher/vehicles/:vehicleId/trips/:tripNo/record` | Real API |
| D05 Validation | `2040:2015` | `/dispatcher/validation` (`/conflicts` redirects) | Real API |
| D06 Deferral decision center | `2102:6674` | `/dispatcher/deferrals` | Real API |
| D06a Confirm deferrals | `2106:9080` | modal on deferrals | Real API |
| D07 What-if simulator | `2040:3085` | `/dispatcher/simulate` | Real API |
| D08 Review & publish | `2040:3406` | `/dispatcher/review` | Real API |
| D08a Plan published | `2040:3820` | state after publish | Real API |
| D09 Live operations | `2041:2782` | `/dispatcher/live` | Real API |
| D09a Shortfall + recovery | `2042:3002` | `/dispatcher/live/exceptions/:id` | Real API |
| D09b Recovery applied | `2042:3534` | same page, after acknowledging | Real API |
| D09c Minor exception · acknowledge | `2106:12012` | same page | Fixture scenario only |
| D10 Analytics & forecast | `2043:3400` | `/dispatcher/analytics` | Fixture |
| D11 Orders & audit | `2043:4020` | `/dispatcher/orders` | Real API |
| D12 Vehicle unavailable · replan | `2044:3828` | `/dispatcher/vehicles/:vehicleId/replan` | Fixture |
| D13 Outlets | `2106:7017` | `/dispatcher/outlets` | Fixture |
| D01-T Command center · tablet | `2045:4016` | `/dispatcher` at 801–1279px | as D01 |
| D01-M Command center · phone | `2045:4446` | `/dispatcher` at ≤800px | as D01 |
| D09-M Live operations · phone | `2045:4609` | `/dispatcher/live` at ≤800px | as D09 |
| X02 Notification center | `2048:7369` | bell panel and `/dispatcher/notifications` | Real API, earlier design |

Prototype: section F (`2116:9223`), 37 frames, guide `2116:9224`.

Files, all under `apps/web/src/features/dispatch/`: `workspace.tsx` (routes, run context),
`shell.tsx` + `shell.css` (Figma shell), `contracts.ts`, `ui.tsx` (small shared pieces),
`rules.ts` (hard-rule labels), `data/` (§3), `engine.ts`, `stream.ts`, `notifications.tsx`,
`demo-clock.tsx`, and one `.tsx` + `.css` per page.

Kept from the earlier `main` workspace: the shared sign-in and role guard, the SSE stream with its
15-second polling fallback, the notification feed and its acknowledge action, the demo clock and
demo reset (now in the account menu at the bottom of the sidebar, with the service-date field),
client-side validation with the planning package before every placement, and `If-Match` on every
write.

## 8. Dispatcher data: real API and gaps

"Real" pages read these existing endpoints through `data/sources/`: `/planning/runs/:date/queue`,
`/vehicles`, `/outlets`, `/district-travel`, `/service-allowances`, `/trips`,
`/dashboard/summary`, `/dashboard/exceptions`, and write through `PUT …/allocations`,
`POST …/auto-allocate`, `POST /planning/validate`, `POST /deferrals`, `POST …/simulate`,
`POST …/publish` and `POST /loading/issues/:id/ack`. No API contract was changed.

What the frames show that the API does not return. Each is either left empty, derived on the
client, or served by a fixture:

| Page | Missing from the API | What the page shows instead |
| --- | --- | --- |
| All | Outlet names | Brand and district beside the outlet code, e.g. "Fresh Colombo" |
| All | Order reference numbers (`ORD-260926-0587`) | `ORD-` plus the first 8 characters of the id |
| Shell | Publish deadline | Cutoff 16:00 the day before, plus the Figma two-hour window |
| D01, D03, D08 | Plan quality score and its change | A plain measure in `sources/plan.ts` (`qualityScore`): share of orders on a trip, trip fill, less hard violations. No change value. |
| D01 | Run-over-run changes, AI insight lines | Not shown (null) |
| D01 | On-time prediction | Share of stops that are not tight on their window |
| D01 operations | Deliveries per hour | Empty chart |
| D02 | `high_value` and `fragile` tags; four runs of deferral history | Tags left out; only the last run is known |
| D02a | Saved views (`/planning/views`) | Fixture, kept in memory |
| D03 | Driver on a vehicle | Not shown |
| D03 | Fit score from an advisor | Load after placing; every candidate has passed the validator |
| D03a | List of single changes with undo | Empty list. "Undo run" takes the placed orders off again, one saved move each. |
| D04 | Fuel used so far this week; a ranked fix for a violation | Planned litres for this run against the weekly quota; no fix card |
| D04a | Loader, dock, driver names; proof-of-delivery flags; correction requests | Left empty; "Send request" answers that the server cannot do it yet |
| D05 | Late-arrival risk | Trips between 90% and 100% load are listed as risks |
| D06 | Policies other than the default; three older runs of history | One policy, from `defaultPriorityWeights` |
| D07 | Costs in rupees; second-trip and cutoff levers; applying a scenario | Extra fuel in litres; the three changes the server simulates; "Copy to draft" answers that it is not available |
| D08a | Publish time and publisher on the trip list; acknowledgement counts | Time kept from this browser's own publish; progress from trip, loading and stop status |
| D09 | First event time; predicted finish; late risk; anomaly card | Bar from planned start to the last event; the rest not shown |
| D09a–b | Recovery options that replan around a shortfall | One option: acknowledge and send short (the real action). It cannot be undone. |
| D10 | `GET /analytics/forecast` | Fixture |
| D11 | Actor names, signature and photo images, received counts | `sources/orders.ts` reads `GET /orders` and `GET /audit`; actors show by role, images are left out |
| D12 | `GET, POST /planning/runs/:date/replans/:vehicleId` | Fixture (VEH052 only) |
| D13 | `GET /outlets/directory`, `GET /outlets/:code/profile` | Fixture |

Fixture pages (D10, D12, D13, D02a) show the Figma scenario, so their orders, outlets and vehicles are
not the ones in the database.

## 9. Open questions

1. **Shared screens X01–X05.** Sign-in was restyled in commit `e7334f7` (not checked against
   X01 here). The Dispatcher's
   notification panel and page work against the real feed but keep the earlier design, not X02.
2. **Reason-code numbers.** Figma shows only R-03. The other numbers (R-01…R-12) in the deferral
   reason list are made up in `rules.ts` and need the real list.
3. **"Needs action" tab on the queue** is read as "unallocated orders".
4. **Figma data that disagrees with itself.** VEH033 appears as a fifth lane on D03; VEH007 is
   feasible in the D03 advice but near its limit on D05; Kurunegala and Peradeniya carry different
   tags on D02 and D13. The fixtures copy each frame as drawn.
5. **Added controls that Figma does not show**, each needed to make a page usable: vehicle picker
   and "Trip record" button on D04, order search and picker on D11, search field and "Show more"
   on D13, confirm dialogs before publishing (D08, D12), the start state of automatic allocation
   (D03a), the menu button on phones, and the service-date field, demo clock and demo reset in the
   account menu.
6. **D01 sliders button** (next to "By cluster") has no behaviour in Figma. It is rendered disabled.
7. **D01 operations view** follows prototype frame P34 for layout. Its header (depot dropdown,
   "Plan Wed 30" button) was left out: the Planning/Operations switch and "Open queue" stay.
8. **D12 has no link from another page** unless the API reports a `vehicle_unavailable` exception.
   The fixture knows VEH052 only.
9. **Outlets default depot.** The page opens on "All depots"; Figma shows "Kandy hub" chosen.
10. **40px controls.** Figma specifies 40px sidebar rows and top-bar controls on desktop.
11. **End-to-end tests.** `e2e/tests/ui-layout.spec.ts` and `roles.real.spec.ts` were written for
    the earlier Dispatcher pages. They have not been re-run or updated.
12. **Geist Mono** (event ids, reason codes) is not installed; `--font-mono` falls back to the
    system monospace font.
13. **Nothing has been viewed in a browser by the developer of these pages.** Checks run: Biome,
    TypeScript, the web unit tests, and every read source plus one place-and-remove of an order
    against the local API. Layout review is by eye, using §10.

## 10. How to check the Dispatcher pages

Run `pnpm dev`, open http://localhost:5173/dispatcher and sign in as
`dispatcher@waypoint.test` / `waypoint-demo`. Compare each page with its Figma frame at a 1440px
wide window. To see the page filled like the frame, run `VITE_DISPATCH_FIXTURES=all pnpm dev`: the
seeded database is much smaller than Figma (13 orders and 3 available vehicles on the run tested).

| Page | Open | Compare with | Try |
| --- | --- | --- | --- |
| D01 | Command center | `2037:496` | Switch to Operations (P34 layout) and back; click an alert row |
| D02 | Planning queue | `2038:1628` | Tabs, search, filters, column menu, select rows, Export |
| D02a | Queue → Save view | `2106:9829` | Save a view, rename, reorder, delete |
| D03 | Allocation | `2039:1075` | Pick an unallocated order, read the advice, assign it; try a blocked vehicle |
| D03a | Allocation → Automatic | `2106:11687` | Run automatic allocation, then Undo run |
| D04 | Fleet & trips | `2040:1447` | Pick a vehicle; open Trip record on a trip with stops |
| D04a | Fleet → Trip record | `2106:11293` | Request a correction (the server refuses, by design for now) |
| D05 | Validation | `2040:2015` | Re-run; with fixtures: reassign the two chilled orders on VEH052 |
| D06 | Deferrals | `2102:6674` | Tick candidates, read the preview, Confirm (D06a modal) |
| D07 | What-if simulator | `2040:3085` | Switch levers on and read the comparison |
| D08 | Review & publish | `2040:3406` | Publish (cannot be undone except by demo reset) → D08a |
| D09 | Live operations | `2041:2782` | Exceptions / All trips, depot, open the alert |
| D09a–b | Live → Open recovery | `2042:3002`, `2042:3534` | Acknowledge a shortfall reported by the loader |
| D09c | fixtures: a minor exception | `2106:12012` | Acknowledge |
| D10 | Analytics & forecast | `2043:3400` | Vehicle class, depot, Export |
| D11 | Orders & audit | `2043:4020` | Source filter, search another order, Open outlet |
| D12 | fixtures: `/dispatcher/vehicles/VEH052/replan` | `2044:3828` | Publish plan v5 → confirm |
| D13 | Outlets | `2106:7017` | Choose "Kandy hub", brand and access chips, search, click a row |
| Shell | any page | `2034:673`, `2034:768` | Account menu (⋯ beside your name): service date, demo clock, sign out; bell; search |
| D01-T | Command center at 1180px wide | `2045:4016` | Icon rail, four KPIs, search button |
| D01-M | Command center at 390px wide | `2045:4446` | Tab bar, two KPIs, compact reefer card |
| D09-M | Live operations at 390px wide | `2045:4609` | Filter button, trip list |

The Store workspace now has its own Figma shell (§11), so `/store` no longer looks as it did.

## 11. Store Manager

Every frame of section D is built, on desktop and phone. The pages work against the real API and
against the Figma scenario; nothing in `packages/shared`, the API or the database was changed.

### Pages

| Frame | Node | Route | Phone frame | Data |
| --- | --- | --- | --- | --- |
| S01 Store home | `2047:5268` | `/store` | S01m `2048:6473` | API + gaps |
| S02 Place order | `2047:6039` | `/store/orders/new`, `/store/orders/:id/edit` | S02m `2106:10922` | API + gaps |
| S02a Cutoff passed | `2047:6406` | `/store/orders/:id/held` | reflow of S02a | API |
| S03 Order confirmation | `2047:6626` | `/store/orders/:id/confirmation` | S03m `2106:11076` | API + gaps |
| S04 Tracking & ETA | `2048:5829` | `/store/deliveries`, `/store/orders/:id` | S04m `2048:6583` | API + gaps |
| S05-W Deferral notice | `2102:7487` | `/store/orders/:id/deferred` | S05 `2048:6691` | API + gaps |
| S06-W Confirm receipt | `2102:7769` | `/store/receipts`, `/store/orders/:id/receipt` | S06 `2048:6817` | API + gaps |
| S06a Receipt with issue | `2048:6921` (desktop: prototype I24 `2179:27813`) | `/store/orders/:id/issue` | S06a | API + gaps |
| S07 Issues | `2048:6257` | `/store/issues` | S07m `2106:11180` | API + gaps |
| Notifications | prototype I29 `2180:27843` | `/store/notifications` | prototype J12 | API + gaps |

States taken from prototype section I: loading skeleton (I02), load error (I05), no current orders
(I03), submit failed (I11), validation (I08), receipt confirmed dialog (I22), issue sent (I27),
tracking steps strip and the delivered state (I16, I18).

### Files (`apps/web/src/features/store/`)

- `workspace.tsx` routes and the workspace context; `shell.tsx` the Figma sidebar, top bar and
  phone tab bar; `ui.tsx` small pieces and date helpers; `states.tsx` loading, error and empty.
- One file per screen: `home`, `place-order`, `confirmation` (S03 and S02a), `tracking`,
  `deferral`, `receipt`, `issue-report`, `issues`, `notifications`; `order-page.tsx` picks the
  screen for an order.
- `data.ts` is the only way to data. `storeApi` sends the requests; `insights` supplies what the
  API lacks. `contracts.ts` types those gaps; `fixtures.ts` is the Figma scenario.
- `store.css`: one file, prefix `st-`. Its first block styles the shared primitives (Icon, Avatar,
  ProgressBar, SegmentedControl, Banner, DeltaBadge, Dropdown, `Button size="md"`), because their
  only other styling is scoped to the Dispatcher workspace. Its last block keeps `.store-signin`,
  `.store-form` and `.store-error`, which the sign-in page and the Dispatcher loading screen use.
- `shared.tsx` is unchanged and no Store page imports it. Driver, Loader and Dispatcher import
  `day`, `time`, `orderName`, `initials`, `useOnline`, `useServerNow`, `clockLabel` and
  `reasonText` from it, so it stays until those move to `lib/`.

### Data modes

| Mode | How | What you see |
| --- | --- | --- |
| Real API | `pnpm dev` and sign in as the store manager | The seeded outlet. Sending an order, confirming a receipt and reporting an issue are real requests. |
| Figma scenario | open `/store?fixtures=on` (off again with `?fixtures=off`), or set `VITE_STORE_FIXTURES=all` | Outlet WF-F071 Gampola on Fri 25 Sep 11:40. Actions change memory only and reset on refresh. Sign-in is still real. |

### Backend gaps (typed in `contracts.ts`, filled by `insights` in `data.ts`)

| Frame shows | The API has | Until then |
| --- | --- | --- |
| Product lines, SKU and "usual" quantity (S02) | An order is units, weight and volume | Fixture catalogue; lines add up to the size that is sent. The lines this browser sent are kept in local storage; other orders show a spread of their cartons. |
| Save draft (S02) | Nothing | Kept in local storage per outlet and date |
| Order number such as ORD-260926-0712 | A UUID | `ORD-` plus the first 8 characters of the id |
| On-time arrivals and the +6% change (S01) | No lateness in the workspace | Past deliveries are listed, none marked late, no change badge |
| Driver name and phone, "stop 1 of 3", first recorded time (S04) | Vehicle id, ETA, last update | "Your driver", no call button, no orange recorded bar |
| Pre-notified shortage and top-up (S04, S06, S07) | Nothing for the store | Not shown |
| Per-product counts on the proof of delivery (S06) | Recipient name, photo flag, time | "Handed over" equals "ordered" |
| Signature image (S06) | Not in the store response | The Figma signature mark when a proof of delivery exists |
| Received counts and a photo on a receipt or issue | Receipt has no body; issue has type and note | Count and product go into the issue note; the photo is chosen but not uploaded |
| "Too warm" issue type (S06a) | missing, damaged, incorrect | Sent as damaged, with "too warm" in the note |
| Ordered / received / short, fix and timeline of an issue (S07) | Type, note, status, created time | Numbers read from the note; fix is "With planning"; a two-step timeline |
| Reason number R-03 and the decider's name (S05) | Reason code, type, note, time | The reason code; "by planning" |
| Planning phone number ("Call planning") | Nothing | The row is shown without a link; the header button is hidden |
| Notification wording (I29) | Type and entity id | One fixed sentence per type |

### Decisions and added controls

- "Deliveries" and "Receipts" open one delivery, as in Figma. An order picker in the page header
  (not in Figma) reaches the others, and the top-bar search lists matching orders.
- The sidebar toggle folds the sidebar to an icon rail. Sign out is in the "⋯" menu on the user
  card; on a phone it is at the foot of the Notifications page.
- The free-text "Note for planning" of the earlier issue form is gone: Figma has no such field.
- On a phone, sending an issue also confirms the receipt (S06a "Confirm with 1 issue"). On desktop
  it sends the issue only (prototype I24 "Submit issue").
- The fixture scenario freezes each order screen at its Figma moment (tracking at 05:44, the held
  order at 16:07), while the top bar keeps the 11:40 clock. The S05-W deferral opens from its
  notification, because its order shares Sat 26 with the draft on the home page.
- `e2e/tests/ui-layout.spec.ts` and `roles.real.spec.ts` still describe the earlier Store pages
  and have not been re-run.

### How to check

Sign in as `store.manager@waypoint.test`, open `/store?fixtures=on`, and compare at 1440px wide,
then at 390px.

| Page | Open | Compare with | Try |
| --- | --- | --- | --- |
| S01 | Store home | `2047:5268` / `2048:6473` | Countdown ticks; click a half; fold the sidebar; "⋯" → Sign out |
| S02 | Place order | `2047:6039` / `2106:10922` | Tabs, search, steppers, the amber sausage warning, Save draft, Submit both orders |
| S03 | after Submit | `2047:6626` / `2106:11076` | Edit order, Back to home (home now shows Confirmed) |
| S04 | Deliveries | `2048:5829` / `2048:6583` | Order picker; the dashed receipt card |
| S06 | Receipts | `2102:7769` / `2048:6817` | Change a count (label becomes "Confirm with 1 issue"); Confirm → dialog |
| S06a | Receipts → Issue on a line | `2048:6921` | Pick a type, a count, Submit issue; try it empty |
| S07 | Issues | `2048:6257` / `2106:11180` | Open and Resolved tabs; select another issue |
| S05 | bell → "Order deferred" | `2102:7487` / `2048:6691` | Got it |
| S02a | bell → "Order held after cutoff" | `2047:6406` | Edit before Monday's cutoff |
| Notifications | bell | `2180:27843` | Mark all read |
| States | stop the API, or go offline in dev tools | I02, I05 | Skeleton, error card with Retry, the offline banner |

Not viewed in a browser by the developer of these pages. Checks run: TypeScript, Biome on the
Store folder, and a production build.
