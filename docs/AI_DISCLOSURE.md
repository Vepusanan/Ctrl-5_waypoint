# AI Tool Disclosure

This page covers the Hackathon build in this repository.

## Tools used

| Tool | Evidence in the repository | Used for |
| --- | --- | --- |
| Claude Code (Anthropic, Claude Opus) | `Co-Authored-By: Claude` trailers in the commit history | Code generation and refactoring, debugging, test writing, documentation |
| Cursor | Project rules in `.cursor/rules/` | In-editor code assistance under the team's architecture, UI and workflow rules |
| Neon agent skills | `.agents/skills/`, `skills-lock.json` | Reference material for the AI assistants when setting up the hosted Neon database |

No AI model runs inside the product. Allocation, validation, priority scoring and analytics are
deterministic code in `packages/planning` and `apps/api`; no model API is called at runtime, and no
Datathon model is integrated.

## AI-assisted work

- **Requirements interpretation.** Turning the competition booklet into the structured
  requirements in `docs/SRS.md` and checking features against it.
- **Code generation.** Drafting API modules, web pages built from the team's Figma frames, the
  planning package and the seed, from prompts written by team members.
- **Debugging.** Finding and fixing defects, including the authentication and role-scope repair
  recorded in `docs/AUTH_FLOW_REPAIR.md`.
- **Test generation.** Unit, integration and Playwright browser tests.
- **UI refinement.** Matching pages to the Figma frames and adding loading, empty and error states.
- **Documentation.** The README and the pages in `docs/`, including this one, the architecture
  page, the data model and the demo script.
- **Submission review.** Auditing the repository, Docker Compose startup and the deployed system
  against the deliverables.

## Human-controlled work

Team members:

- chose the architecture, the technology stack and the hosting (Render and Neon);
- designed the four role experiences in Figma for the Designathon;
- decided the business rules and assumptions and checked them against the booklet;
- wrote the prompts and the project rules the assistants worked under;
- reviewed, changed or rejected generated code before committing it;
- ran the workflows by hand in each role and decided what was fit to submit;
- controlled the repository, the deployment, the credentials and the submission.

The confidential competition datasets stay in the gitignored `data/` folder. The project rules
forbid committing or uploading them.

## How AI output was validated

- **Code review** by a team member before merge.
- **Automated gates** on every push (GitHub Actions): Biome lint and format, strict TypeScript,
  Knip, Vitest unit and integration tests against PostgreSQL, the production build and the
  Playwright browser specs.
- **Planning rules** tested in isolation in `packages/planning/test`, so a generated change cannot
  silently relax a hard constraint.
- **Manual end-to-end runs** of the judge walkthrough across all four roles, locally and on the
  deployed system.
- **Requirement traceability** against `docs/SRS.md`.
