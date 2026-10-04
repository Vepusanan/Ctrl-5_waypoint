# Demo video script (5 minutes)

About 650 spoken words. The steps match the judge walkthrough in the [README](../README.md#judge-walkthrough).
To fit the time, the Driver's first (online) delivery and the Loader's carton counts can be done
before recording or cut in editing; the script marks where.

URL: https://ctrl-5-waypoint.onrender.com · all accounts use the password `waypoint-demo`.

---

### 0:00–0:20 — Introduction

**Screen:** Sign-in page.

**Say:**
"This is Waypoint, by team Ctrl-5. Today a delivery day runs on phone calls, spreadsheets and
printed run sheets, and on a busy day there are more orders than trucks. Waypoint gives the store
manager, the dispatcher, the loader and the driver one shared record of that day. I'll follow one
order through all four roles."

### 0:20–0:55 — Store Manager

**Screen:** Sign in as `store.manager@waypoint.test`. Home page → Place order → Dry tab → add
cartons → Submit.

**Say:**
"The store manager sees this outlet's orders only. A chilled order for tomorrow is already open,
and I'll add a dry one. Orders stay editable until the four p.m. cutoff. After that they lock, so
the dispatcher plans against numbers that can't move underneath them."

### 0:55–1:50 — Dispatcher planning

**Screen:** Dispatcher window. Planning queue: the notice at the top says two submitted orders
are waiting for the cutoff → Close orders now (demo clock). Planning queue → Allocation →
Automatic → Run automatic allocation → Assisted: put a chilled order on a dry truck → Deferrals:
tick the order, type the justification, Confirm → Review & publish → Publish.

**Say:**
"The store's orders are still open, so the dispatcher is told two are waiting. I press Close
orders now, which moves the demo clock past the four p.m. cutoff. The queue now holds every
confirmed order, and one deferred yesterday comes back with its history, so it isn't skipped twice.

Automatic allocation builds a feasible plan in one step. It can only rank options that pass the
hard rules: weight, volume, refrigeration, van-only access, home depot, delivery windows, fuel
quota and two trips per vehicle.

The dispatcher stays in control. If I put a chilled order on a dry truck, the system refuses and
says which rule failed.

Today there's more demand than capacity. This order fits no vehicle, so I defer it with a reason,
and that decision is recorded and shown to the store. Then I publish, and the loader, the drivers
and the stores are all notified."

### 1:50–2:25 — Loader

**Screen:** Loader window at tablet width. Open VEH035 → Start loading → Report shortfall → Send.
Switch to Dispatcher → Live operations → open the shortfall → Apply. Back to Loader → (stops
already counted) Verify load → Confirm verification → Mark Ready.

**Say:**
"The loader gets the published plan on a tablet. Stops are listed last drop first, so the first
delivery is nearest the door. Two cartons are missing, so I report a shortfall. The vehicle can't
be marked ready until the dispatcher has seen it, which stops a known problem from leaving the
depot silently. The dispatcher acknowledges, the loader verifies the load, and the vehicle is ready."

*(Count the cartons for the other stops before recording, or cut that part.)*

### 2:25–3:15 — Driver and offline

**Screen:** Dispatcher → account menu → Service morning. Driver window at phone width: trip with
the first stop already delivered. DevTools → Network → Offline. Offline bar appears. Open the next
stop → I've arrived → Record delivery → name, signature → Complete delivery. Header shows pending
count. Network → Online. Open Sync: events show Synced.

**Say:**
"The driver sees only this vehicle's trip: the stops, the delivery windows and the access notes.

Drivers lose signal in basements and loading bays, so here is our degradation scenario. I cut the
connection. The app says it is offline and keeps working from the route saved on the phone. I
record the arrival, the delivery, and proof of delivery with a name and a signature. Each one is
saved on the phone first and shown as pending. Nothing is lost and nothing is faked.

When the connection returns, the queue syncs by itself. Every event carries its own id, so if the
same event is sent twice the server applies it once."

*(Do the first stop online before recording.)*

### 3:15–3:40 — Store receipt

**Screen:** Store Manager window → Receipts. Show the proof of delivery → Report an issue on a
line → Confirm receipt.

**Say:**
"Back at the store, the manager sees the delivery and the driver's proof of delivery, signature
included. One line arrived short, so I report it and confirm the receipt. The store and the depot
now have the same evidence, so a dispute doesn't become a phone call."

### 3:40–4:10 — Dispatcher final view

**Screen:** Dispatcher → Live operations (completed stops) → Store issues → Resolve issue → Orders
& audit → search the outlet → event log.

**Say:**
"The dispatcher sees the day close in real time: completed stops, the loading shortfall and the
store's issue, which I resolve here. And for any order there is a full audit trail: who did what,
when, from the cutoff to the receipt. If a vehicle breaks down after publishing, the same
validator replans its orders and leaves trips already on the road untouched."

### 4:10–4:40 — Code and architecture

**Screen:** Editor with three files pre-opened, about eight seconds each, then
`docs/architecture.md` rendered with the diagram visible.

| Order | File | Point at | One sentence |
| --- | --- | --- | --- |
| 1 | `packages/planning/src/validator.ts` | `validatePlan` (and `tripViolations` above it) | "Every hard rule lives in one pure function, shared by the browser and the server, so no screen can save a plan that breaks a constraint." |
| 2 | `apps/api/src/modules/sync/service.ts` | `replay`, with the unique `client_event_id` in `packages/database/src/schema/field.ts` | "An offline event that arrives twice is recognised by its id and answered as a duplicate, which is why reconnecting never double-delivers." |
| 3 | `apps/api/src/plugins/rbac.ts` | `scope` | "Each user's outlet, depot or vehicle is added to every query on the server, so a driver cannot read another vehicle's trips even by calling the API directly." |

**Say (over the diagram):**
"It's a TypeScript monorepo: a React PWA, a Fastify API and PostgreSQL. The planning rules are a
separate package used by both sides. It runs as one container on Render with a Neon database, and
`docker compose up` starts the same stack locally with seed data."

### 4:40–5:00 — Closing

**Screen:** Dispatcher dashboard, or the sign-in page with the URL visible.

**Say:**
"So that's one order: placed, planned under real constraints, loaded, delivered offline, received
and audited, with every role looking at the same record. The link, the four accounts and the
walkthrough are in the README. Thank you."

---

# Recording Preparation

## Checklist

- [ ] Reset demo data: Dispatcher → account menu "⋯" → Reset demo data (this signs every window out; sign in again)
- [ ] Open the deployed URL a few minutes early so the free service is awake
- [ ] Sign in to all four accounts and confirm each workspace loads
- [ ] One browser window per role, each in its own profile or private window, so sessions don't replace each other
- [ ] Set the Loader window to tablet width (about 1180 × 820) and the Driver window to phone width (390 × 844)
- [ ] Open DevTools in the Driver window on the Network tab, docked so the Offline switch is one click away
- [ ] Zoom the desktop windows to 110–125% so text is readable at 1080p
- [ ] Clear unrelated notifications in each workspace (a fresh reset does this)
- [ ] Hide the bookmarks bar, other tabs, saved-password prompts and anything personal
- [ ] Keep `.env`, the Render dashboard and the Neon console closed
- [ ] Pre-open the three code files at the right function, and `docs/architecture.md` in preview
- [ ] Turn on Do Not Disturb; quit chat and mail apps
- [ ] Check the microphone level with a ten-second test recording
- [ ] Use a stable connection (the only planned offline moment is the Driver's)
- [ ] Rehearse once from start to finish with a timer, then reset demo data again
- [ ] Record
- [ ] Upload to YouTube as **Unlisted** and open the link in a private window to check it plays

## Window setup for switching roles

Arrange the windows in the order they are used, then switch with the keyboard (Cmd+` on macOS,
Alt+Tab on Windows) instead of signing in and out:

1. **Store Manager** — desktop width
2. **Dispatcher** — desktop width, full screen
3. **Loader** — tablet width
4. **Driver** — phone width, DevTools open
5. **Editor** — three code files and the architecture preview

Order of visits: 1 → 2 → 3 → 2 → 3 → 2 → 4 → 1 → 2 → 5. The Dispatcher window is visited four
times, so keep it adjacent to everything else.

To save time on screen, set up these states before pressing record, then start from the sign-in
page of window 1: all four windows already signed in, and nothing else. During the Loader segment
the carton counts, and during the Driver segment the first online delivery, are the two places to
cut if the recording runs long.

If a take goes wrong, Reset demo data returns every window to the start; refresh each window after
the reset.
