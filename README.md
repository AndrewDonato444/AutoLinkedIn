# AutoLinkedIn (GojiBerry Auto)

Automation layer that turns LinkedIn outreach into a scheduled loop: discover leads from a plain-English ICP, enrich them with intent signals, generate personalized messages, and queue everything inside GojiBerry for one-click approval. No UI of its own. Claude (or a cron job) drives it, GojiBerry executes against LinkedIn.

Nothing sends without approval inside GojiBerry. This repo only fills the queue.

## What you need before setup

1. A GojiBerry account with LinkedIn linked (you do this once inside GojiBerry).
2. A GojiBerry API key from `ext.gojiberry.ai`.
3. Node 20+ and `npm`.
4. (Optional, for the optimization loop) An Anthropic API key.
5. macOS if you want the scheduled overnight runs via launchd. Other OSes work fine for manual runs and standard cron.

## Setup

```bash
git clone https://github.com/AndrewDonato444/AutoLinkedIn.git
cd AutoLinkedIn
npm install
cp .env.local.example .env.local   # or create .env.local manually using the keys below
```

Fill in `.env.local`:

```bash
# GojiBerry
GOJIBERRY_API_KEY=...               # from gojiberry.ai
GOJIBERRY_API_URL=https://ext.gojiberry.ai
GOJIBERRY_MCP_URL=https://mcp.gojiberry.ai

# What kind of leads you want, in plain English
ICP_DESCRIPTION="Series A SaaS founders in NYC hiring their first head of sales"

# Guardrails
DAILY_LEAD_SCAN_LIMIT=10            # how many new contacts per day
MIN_INTENT_SCORE=50                 # 0-100, leads below this are dropped

# Cron expressions for scheduled runs
DAILY_SCAN_CRON="0 7 * * 1-5"       # 7am weekdays
WEEKLY_REPORT_CRON="0 8 * * 1"      # Monday 8am
```

Verify the setup:

```bash
npm run typecheck
npm test
```

## Running automations manually

Each automation is a script under `src/automations/`. Run them with `tsx` or compile and run with node. The most useful ones:

| Script | What it does |
|--------|--------------|
| `daily-lead-scan.ts` | Full loop: discover → enrich → score → generate messages. The main one. |
| `morning-briefing.ts` | Plain-English summary of pipeline + warm leads (read this with coffee). |
| `pipeline-overview-report.ts` | On-demand pipeline snapshot. |
| `weekly-performance-report.ts` | Campaign analytics + recommendations. |
| `campaign-health-monitor.ts` | Flags stalled or unhealthy campaigns. |
| `icp-refinement.ts` | Looks at who actually replied, suggests ICP tweaks. |
| `message-style-optimization.ts` | Patterns in what worked, applies to next batch. |
| `lead-quality-feedback-loop.ts` | Pushes signal from real replies back into enrichment. |

Example:

```bash
npx tsx src/automations/daily-lead-scan.ts
npx tsx src/automations/morning-briefing.ts
```

Output goes to stdout and (where relevant) `data/scan-logs/`.

## Scheduling overnight runs (macOS)

This is what makes it hands-off. The launchd jobs in `scripts/launchd/` run the daily scan, weekly report, and nightly review on the cron expressions you set in `.env.local`.

```bash
./scripts/setup-overnight.sh        # install launchd jobs
./scripts/uninstall-overnight.sh    # remove them
```

After install, jobs live in `~/Library/LaunchAgents/com.sdd.*.plist` and write logs to `logs/`.

On Linux, ignore the launchd scripts and wire `daily-lead-scan.ts` into your own cron or systemd timer.

## How a typical day looks

1. Cron fires `daily-lead-scan` at 7am.
2. New contacts land in GojiBerry with intent scores and draft messages attached.
3. Morning briefing runs, prints a summary you actually read.
4. You open GojiBerry, glance at the queue, approve the ones worth sending.
5. GojiBerry pushes them to LinkedIn under your account.
6. Weekly report on Monday tells you what worked. Optimization scripts feed that back into next week's runs.

The system is a queue filler with an opinion. The approval step is intentional. You stay the bottleneck on tone and judgment, the machine handles the grind.

## Project structure

```
src/
├── api/                  GojiBerry REST client, rate limiter, error types
├── automations/          The scripts you actually run
├── contacts/             Master contact store, Apollo enricher, sync logic
├── messages/             Message regeneration utilities
└── utils/                Shared helpers

scripts/                  Shell scripts (setup, overnight loops, mapping)
scripts/launchd/          macOS launchd plists
data/                     Local data (contact store, scan logs) — gitignored
.specs/                   Specs, roadmap, vision (spec-driven dev)
tests/                    Vitest suite
```

## Troubleshooting

**`AuthError` on first run.** Your `GOJIBERRY_API_KEY` is wrong or your bearer token expired. Regenerate it from GojiBerry settings.

**Rate-limit errors.** The client backs off automatically (`RATE_LIMIT_BACKOFF`, `RATE_LIMIT_MAX_WAIT` in `.env.local`). If you're hitting it constantly, lower `DAILY_LEAD_SCAN_LIMIT`.

**No leads coming back.** Either your `ICP_DESCRIPTION` is too narrow, or `MIN_INTENT_SCORE` is too high. Drop the threshold first, then loosen the ICP.

**Scheduled jobs not running.** `launchctl list | grep com.sdd` to confirm they're loaded. Logs in `logs/`.

## Notes

This started as a single nightly script and grew into a spec-driven project. Specs and roadmap live in `.specs/` if you want to see what each automation is supposed to do before you read the code.
