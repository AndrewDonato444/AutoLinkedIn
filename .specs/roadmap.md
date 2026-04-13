# GojiBerry Auto — Roadmap

## Implementation Rules

1. No mock data — all automations hit the real GojiBerry API (`ext.gojiberry.ai`)
2. Real error handling — rate limits (100 req/min), auth failures, empty results
3. Every automation has an approval gate before anything reaches LinkedIn
4. Configuration lives in `.env.local` — no hardcoded API keys, ICPs, or schedules
5. Each feature is a self-contained automation (script or scheduled task) that can run independently

## Progress

| Phase | Features | Done | Status |
|-------|----------|------|--------|
| 1: Core Pipeline | 4 | 3 | ⏸️ |
| 2: Intelligence Layer | 4 | 1 | 🔄 |
| 3: Automation & Scheduling | 4 | 0 | ⬜ |
| 4: Optimization Loop | 3 | 0 | ⬜ |

**Overall: 4/15 (27%) — Last updated: 2026-04-13 — Feature 11 next**

---

## Phase 1: Core Pipeline

Get leads from the web into GojiBerry with personalized messages. The minimum viable loop.

| # | Feature | Source | Complexity | Deps | Status |
|---|---------|--------|------------|------|--------|
| 1 | GojiBerry API client | vision | M | - | ✅ |
| 2 | ICP-based lead discovery | vision | M | 1 | ✅ |
| 3 | Lead enrichment + intent scoring | vision | M | 1 | ✅ |
| 4 | Personalized message generation | vision | M | 1,3 | ⏸️ |

**Feature 1 — GojiBerry API client**: Shell-based or script-based wrapper around the GojiBerry REST API. Handles auth (bearer token from `.env.local`), CRUD for contacts, campaign retrieval, list retrieval. Includes rate limit handling (100 req/min) and error reporting. This is the foundation everything else calls.

**Feature 2 — ICP-based lead discovery**: Claude automation that reads `ICP_DESCRIPTION` from `.env.local`, searches the web for matching leads, and creates contacts in GojiBerry via `POST /v1/contact`. Outputs a summary of leads found with basic info (name, company, title, profile URL).

**Feature 3 — Lead enrichment + intent scoring**: Takes existing GojiBerry contacts, researches each one (online activity, recent posts, company news, buying signals), and updates them via `PATCH /v1/contact/{id}` with fit score and intent signals. Respects `MIN_INTENT_SCORE` threshold.

**Feature 4 — Personalized message generation**: For enriched leads above the intent threshold, generates hyper-personalized LinkedIn messages based on the enrichment data. Stores messages on the contact via `PATCH /v1/contact/{id}` (personalizedMessages field). Messages sit in GojiBerry ready for campaign launch — nothing sends without user approval in GojiBerry UI.

---

## Phase 2: Intelligence Layer

Understand what's working and surface the right information at the right time.

| # | Feature | Source | Complexity | Deps | Status |
|---|---------|--------|------------|------|--------|
| 10 | Pipeline overview report | vision | S | 1 | ✅ |
| 11 | Campaign performance analytics | vision | M | 1 | ⬜ |
| 12 | Intent type breakdown | vision | S | 1 | ⬜ |
| 13 | Warm lead list builder | vision | M | 1,3 | ⬜ |

**Feature 10 — Pipeline overview report**: On-demand automation that pulls contacts (`GET /v1/contact` with filters), campaigns (`GET /v1/campaign`), and intent counts (`GET /v1/contact/intent-type-counts`) to generate a plain-English pipeline summary. "You have 142 contacts, 23 are warm, 3 campaigns active, top intent type is hiring."

**Feature 11 — Campaign performance analytics**: Pulls all campaigns, compares metrics (active vs. completed), identifies patterns. Generates a weekly-style report: what worked, what didn't, reply rate trends, which lead segments convert best.

**Feature 12 — Intent type breakdown**: Simple report from `GET /v1/contact/intent-type-counts` plus deeper analysis — which intent types lead to replies, which are noise, where to focus discovery.

**Feature 13 — Warm lead list builder**: Combines score filtering (`scoreFrom`/`scoreTo`), date filtering (`dateFrom`/`dateTo`), and intent type filtering to surface the hottest leads. Outputs a prioritized list with reason-for-warmth for each.

---

## Phase 3: Automation & Scheduling

Make it hands-off. Set up recurring automations so the user only approves.

| # | Feature | Source | Complexity | Deps | Status |
|---|---------|--------|------------|------|--------|
| 20 | Daily lead scan automation | vision | M | 2,3,4 | ⬜ |
| 21 | Weekly performance report | vision | S | 11 | ⬜ |
| 22 | Morning briefing | vision | M | 10,13 | ⬜ |
| 23 | Campaign health monitor | vision | S | 11 | ⬜ |

**Feature 20 — Daily lead scan automation**: Scheduled task (cron via `DAILY_SCAN_CRON`) that runs the full pipeline: discover → create → enrich → score → generate messages. Outputs a summary for user review. Respects `DAILY_LEAD_SCAN_LIMIT`. This is the core "wake up to leads ready" automation.

**Feature 21 — Weekly performance report**: Scheduled task (cron via `WEEKLY_REPORT_CRON`) that runs campaign analytics and delivers a summary: metrics, trends, recommendations. Sent as a report the user reviews Monday morning.

**Feature 22 — Morning briefing**: Combines pipeline overview + warm leads into a single daily digest. "Here's what happened overnight: 12 new leads found, 8 enriched above threshold, 5 messages ready for review. Top 3 by intent: [names]. Open GojiBerry to approve."

**Feature 23 — Campaign health monitor**: Checks active campaigns for stalls (no activity), high bounce rates, or LinkedIn warnings. Alerts the user if intervention is needed. Prevents "set and forget" campaigns from silently dying.

---

## Phase 4: Optimization Loop

Make it smarter over time. Each campaign's results improve the next one.

| # | Feature | Source | Complexity | Deps | Status |
|---|---------|--------|------------|------|--------|
| 30 | ICP refinement from results | vision | M | 11,2 | ⬜ |
| 31 | Message style optimization | vision | M | 11,4 | ⬜ |
| 32 | Lead quality feedback loop | vision | L | 11,3 | ⬜ |

**Feature 30 — ICP refinement from results**: Analyzes which leads actually reply and convert. Compares their profiles against the ICP description. Suggests refinements: "Your ICP says 'series A SaaS founders' but your best replies come from 'seed-stage fintech founders.' Consider updating." User approves changes to ICP_DESCRIPTION.

**Feature 31 — Message style optimization**: Compares message patterns across campaigns. Identifies what hooks work (question openers vs. compliment openers vs. direct ask), optimal message length, and which personalization elements drive replies. Updates message generation approach.

**Feature 32 — Lead quality feedback loop**: Connects the full loop — discovery signals → enrichment quality → message effectiveness → campaign results. Identifies which intent types actually predict replies, which enrichment fields matter most, and adjusts scoring weights. This is the compounding intelligence layer.

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ⬜ | Pending |
| 🔄 | In Progress |
| ✅ | Completed |
| ⏸️ | Blocked |
| ❌ | Cancelled |

## Complexity Legend

| Size | Scope |
|------|-------|
| S | 1-3 files, single automation |
| M | 3-7 files, multiple components/scripts |
| L | 7-15 files, full feature with feedback loops |

## Notes

- **No UI to build.** Every feature is a script, scheduled task, or Claude automation that talks to the GojiBerry API.
- **Phase 1 is the whole value prop.** If a user can go from ICP description to personalized messages in GojiBerry in one run, the product works.
- **The API surface is limited** (contacts, campaigns, lists) — this constrains what we can automate vs. what requires the user to act in GojiBerry's UI (campaign launch, LinkedIn connection).
- **Rate limit awareness** is critical. 100 req/min means a batch of 50 leads with enrichment = ~150 API calls. Need to pace operations.
- **Approval gate is GojiBerry's UI**, not something we build. Messages get written to contacts; user launches campaigns from the dashboard.
