# Submission checklist

Boxes ticked below were verified on 4 October 2026. Unticked boxes still need a team member.

## Deployed System

- [x] Public URL works — https://ctrl-5-waypoint.onrender.com (`/api/health` reports the database up)
- [x] Dispatcher account works — `dispatcher@waypoint.test`
- [x] Loader account works — `loader@waypoint.test`
- [x] Driver account works — `driver@waypoint.test`
- [x] Store Manager account works — `store.manager@waypoint.test`
- [ ] Reset demo data just before submitting, so judges start from the seeded state
- [ ] Keep the Render service and the Neon database running for the whole evaluation period

## Repository

- [ ] Correct repository name — must be `TeamName_SolutionName`; the remote is currently `Ctrl-5---Tech-Triathlon-2026-`
- [ ] Judges have access to the repository (public, or invited if private)
- [x] README complete
- [x] `.env.example` complete, placeholders only
- [x] Docker Compose works
- [x] Fresh clone can start the system (`cp .env.example .env && docker compose up --build`)
- [x] Seed data loaded (four accounts and a delivery day; synthetic data when `data/` is empty)
- [x] No secrets committed (`.env` is gitignored and was never in history)
- [ ] Final changes committed and pushed to `main`

## Documentation

- [x] Architecture diagram — [architecture.md](architecture.md)
- [x] Data model — [data-model.md](data-model.md)
- [x] AI disclosure — [AI_DISCLOSURE.md](AI_DISCLOSURE.md) (team to confirm the tool list is complete)
- [x] Judge walkthrough — [README](../README.md#judge-walkthrough)
- [x] Designathon departures — [README](../README.md#designathon-departures) (team to confirm against the submitted design)

## Demo Video

Script: [demo-script.md](demo-script.md)

- [ ] Approximately 5 minutes
- [ ] All four roles shown
- [ ] End-to-end workflow demonstrated
- [ ] Offline/degradation scenario demonstrated
- [ ] Code explained briefly
- [ ] Architecture explained briefly
- [ ] YouTube visibility = Unlisted
- [ ] Link verified in a private window
- [ ] Link added to the submission form
