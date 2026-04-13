---
feature: Weekly Performance Report
domain: automation
source: src/automations/weekly-performance-report.ts
tests:
  - tests/automations/weekly-performance-report.test.ts
components: []
design_refs: []
status: implemented
created: 2026-04-13
updated: 2026-04-13
---

# Weekly Performance Report

**Source File**: src/automations/weekly-performance-report.ts
**Depends On**: Campaign Performance Analytics (Feature 11)

## Overview

Scheduled automation (cron via `WEEKLY_REPORT_CRON`) that runs campaign analytics and delivers a summary the founder can review Monday morning. Wraps the existing `analyzeCampaignPerformance()` from Feature 11 with scheduling logic, week-over-week comparison, and actionable recommendations.

The founder wants to spend zero time digging through dashboards. This report answers: "How did my outreach do this week, and what should I change?"

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOJIBERRY_API_KEY` | Yes | — | Bearer token for GojiBerry API |
| `WEEKLY_REPORT_CRON` | No | `0 8 * * 1` | Cron schedule (default: Monday 8am) |
| `WEEKLY_REPORT_LOOKBACK_DAYS` | No | `7` | Days of data to include in weekly window |

## Feature: Weekly Performance Report

### Scenario: Generate a weekly report with campaign metrics and recommendations
Given the founder has campaigns in GojiBerry with metrics data
And the `GOJIBERRY_API_KEY` is configured
When the weekly performance report runs
Then it calls `analyzeCampaignPerformance()` to pull campaign data
And it computes week-over-week changes for reply rate, open rate, and messages sent
And it generates up to 3 actionable recommendations based on the data
And it outputs a plain-English report the founder can scan in under a minute

### Scenario: First run with no previous report (no week-over-week comparison)
Given this is the first time the weekly report runs
And there is no stored previous-week snapshot
When the weekly performance report runs
Then it generates the report with current-week metrics only
And it skips week-over-week deltas (marks them as "first report — no comparison yet")
And it still generates recommendations based on absolute metrics

### Scenario: Week-over-week reply rate improved
Given the previous week's average reply rate was 4.2%
And this week's average reply rate is 6.1%
When the weekly report computes week-over-week changes
Then it shows reply rate delta as "+1.9pp" with an "improving" indicator
And it highlights which campaigns drove the improvement

### Scenario: Week-over-week reply rate declined
Given the previous week's average reply rate was 6.1%
And this week's average reply rate is 3.8%
When the weekly report computes week-over-week changes
Then it shows reply rate delta as "−2.3pp" with a "declining" indicator
And it recommends reviewing message personalization and lead quality

### Scenario: No campaigns have sends this week
Given all campaigns have 0 messages sent in the lookback window
When the weekly performance report runs
Then it outputs "No outreach activity this week — nothing to report"
And it recommends "Launch a campaign or check if active campaigns are stalled"
And it returns the report with empty metrics

### Scenario: Zero campaigns exist
Given GojiBerry returns no campaigns
When the weekly performance report runs
Then it outputs "No campaigns found — create a campaign in GojiBerry to start tracking performance"
And it returns early without generating recommendations

### Scenario: Generate recommendations from campaign patterns
Given there are multiple campaigns with varying reply rates
When the weekly performance report generates recommendations
Then it checks for these patterns and recommends accordingly:
  - If top campaign reply rate is 2x+ the average → "Double down on what's working in {campaign}: replicate its approach"
  - If any active campaign has 0 replies after 20+ sends → "Campaign {name} isn't getting replies — consider pausing and revising messages"
  - If overall reply rate is below 3% → "Reply rates are low across the board — review your ICP targeting and message personalization"
And it caps recommendations at 3 (most impactful first)

### Scenario: Store weekly snapshot for future comparison
Given the weekly report runs successfully
When the report is complete
Then it saves a snapshot of this week's metrics to `data/weekly-snapshots/{date}.json`
And the snapshot includes: date, average reply rate, average open rate, total sent, total replied, campaign count
And the snapshot can be loaded on the next run for week-over-week comparison

### Scenario: Handle API authentication failure
Given the `GOJIBERRY_API_KEY` is invalid or expired
When the weekly performance report runs
Then it throws an `AuthError` from the underlying analytics call
And it does not output a partial report
And it does not save a snapshot

### Scenario: Schedule weekly report via cron
Given `WEEKLY_REPORT_CRON` is set to `0 8 * * 1` (Monday 8am)
When the automation scheduler evaluates the cron expression
Then it runs the weekly performance report at the configured time
And it outputs the report for the founder to review

## Output Format

```
=== Weekly Performance Report ({date_range}) ===

This Week: {campaigns_active} active campaigns, {total_sent} messages sent, {avg_reply_rate}% avg reply rate
vs. Last Week: {delta_sent} messages sent, reply rate {delta_reply_rate}pp ({improving|declining|stable})

--- Top Campaigns This Week ---
  1. "{name}" — {reply_rate}% reply rate ({replied}/{sent} replies)
  2. "{name}" — {reply_rate}% reply rate ({replied}/{sent} replies)

--- Needs Attention ---
  "{name}" — {reply_rate}% reply rate after {sent} sends

--- Recommendations ---
  1. {recommendation}
  2. {recommendation}
  3. {recommendation}

Next report: {next_run_date}
```

## Function Signature

```typescript
export interface WeeklySnapshot {
  date: string;
  avgReplyRate: number;
  avgOpenRate: number;
  totalSent: number;
  totalReplied: number;
  campaignCount: number;
}

export interface WeeklyReport {
  currentWeek: CampaignReport;
  previousWeek: WeeklySnapshot | null;
  deltas: {
    replyRate: number | null;
    openRate: number | null;
    sentChange: number | null;
  };
  recommendations: string[];
  reportText: string;
  snapshot: WeeklySnapshot;
}

type WeeklyReportClient = Pick<GojiBerryClient, 'getCampaigns'>;

export async function generateWeeklyReport(options?: {
  _client?: WeeklyReportClient;
  _snapshotDir?: string;
  lookbackDays?: number;
}): Promise<WeeklyReport>;
```

## Dependencies

- `analyzeCampaignPerformance()` from `src/automations/campaign-performance-analytics.ts` — provides the core campaign metrics
- `CampaignReport` type from the same module
- `GojiBerryClient` from `src/api/gojiberry-client.ts`
- `fs` for reading/writing weekly snapshots to `data/weekly-snapshots/`

## Snapshot Storage

Weekly snapshots are stored as JSON files in `data/weekly-snapshots/`:

```
data/weekly-snapshots/
  2026-04-07.json
  2026-04-14.json
  ...
```

Each file contains a `WeeklySnapshot` object. On each run, the automation:
1. Looks for the most recent snapshot file (by date in filename)
2. Uses it for week-over-week comparison
3. Saves the current week's snapshot after generating the report

The `_snapshotDir` option in the function signature allows tests to use a temp directory.

## Learnings

- The `lookbackDays` option affects the date-range label in the report header but not the actual API call (which returns all campaign data); filtering by time window is delegated to `analyzeCampaignPerformance`.
- Snapshot files are named by ISO date (`YYYY-MM-DD.json`) and sorted lexicographically to find the most recent — no date parsing needed.
- The stability threshold (`DELTA_STABILITY_THRESHOLD_PP = 0.05`) treats sub-0.05pp changes as "stable" to avoid noise from rounding.
- When `_snapshotDir` is a fresh tmpdir, `loadMostRecentSnapshot` returns `null` (no files found), which correctly triggers the "first report" path without needing explicit setup.
- The `({change})` placeholder in earlier spec drafts was ambiguous; the code omits the secondary parenthetical after sent count — output is `{delta_sent} messages sent, reply rate {delta_reply_rate}pp ({indicator})`.
