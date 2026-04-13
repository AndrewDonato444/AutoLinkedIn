---
feature: Campaign Health Monitor
domain: automation
source: src/automations/campaign-health-monitor.ts
tests:
  - tests/automations/campaign-health-monitor.test.ts
components: []
design_refs: []
status: implemented
created: 2026-04-13
updated: 2026-04-13
---

# Campaign Health Monitor

**Source File**: src/automations/campaign-health-monitor.ts
**Depends On**: Campaign Performance Analytics (Feature 11)

## Overview

Scheduled automation (cron via `CAMPAIGN_HEALTH_CRON`) that checks active campaigns for stalls, high bounce rates, or warning signs. Alerts the founder when a campaign needs intervention. Prevents the "set and forget" problem — campaigns silently dying while the founder assumes outreach is running.

The founder wants to know: "Are my campaigns actually working right now, or did something break?" without checking dashboards daily. This is the smoke alarm for outreach.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOJIBERRY_API_KEY` | Yes | — | Bearer token for GojiBerry API |
| `CAMPAIGN_HEALTH_CRON` | No | `0 9 * * *` | Cron schedule (default: daily at 9am) |
| `STALL_THRESHOLD_DAYS` | No | `3` | Days with no new sends before a campaign is "stalled" |
| `LOW_REPLY_RATE_THRESHOLD` | No | `2` | Reply rate % below which a campaign is flagged |
| `MIN_SENDS_FOR_ANALYSIS` | No | `10` | Minimum sends before flagging reply rate issues |

## Feature: Campaign Health Monitor

### Scenario: All active campaigns are healthy
Given the founder has active campaigns in GojiBerry
And all campaigns have sent messages within the last `STALL_THRESHOLD_DAYS` days
And all campaigns with sufficient sends have reply rates above `LOW_REPLY_RATE_THRESHOLD`
When the campaign health monitor runs
Then it outputs "All campaigns healthy — no issues detected"
And it returns a health report with zero alerts
And it saves a health snapshot for future comparison

### Scenario: Detect a stalled campaign with no recent activity
Given campaign "Series A Founders Q2" has been active for 7 days
But the campaign's last send was more than `STALL_THRESHOLD_DAYS` days ago
When the campaign health monitor runs
Then it flags the campaign as "stalled"
And the alert says "Campaign 'Series A Founders Q2' appears stalled — no sends in {n} days. Check if it's paused or out of leads."
And the alert severity is "warning"

### Scenario: Detect a campaign with a low reply rate
Given campaign "Cold Outreach Batch 3" has sent 25 messages
And the reply rate is 0.8% (well below `LOW_REPLY_RATE_THRESHOLD`)
When the campaign health monitor runs
Then it flags the campaign as "low reply rate"
And the alert says "Campaign 'Cold Outreach Batch 3' has a 0.8% reply rate after 25 sends — consider revising messages or pausing"
And the alert severity is "warning"

### Scenario: Skip reply rate check for campaigns with too few sends
Given campaign "New Test Campaign" has sent only 3 messages (below `MIN_SENDS_FOR_ANALYSIS`)
And the reply rate is 0%
When the campaign health monitor runs
Then it does not flag the campaign for low reply rate
And it marks the campaign as "too early to evaluate — {sent}/{min_sends} sends"

### Scenario: Detect multiple issues on the same campaign
Given campaign "Stale Outreach" has no sends in 5 days
And its reply rate is 1.2% after 40 sends
When the campaign health monitor runs
Then it flags the campaign with both "stalled" and "low reply rate" alerts
And both alerts appear in the report under the same campaign

### Scenario: Zero active campaigns
Given GojiBerry has no active campaigns (all are completed, paused, or draft)
When the campaign health monitor runs
Then it outputs "No active campaigns to monitor — launch a campaign in GojiBerry to start tracking"
And it returns an empty health report with zero alerts

### Scenario: All campaigns are drafts or paused
Given GojiBerry has campaigns but none are active
When the campaign health monitor runs
Then it outputs "No active campaigns to monitor — you have {n} paused and {n} draft campaigns"
And the report includes a suggestion: "Resume a paused campaign or launch a draft to get outreach running"

### Scenario: Handle API authentication failure
Given the `GOJIBERRY_API_KEY` is invalid or expired
When the campaign health monitor runs
Then it throws an `AuthError` from the underlying API call
And it does not output a partial health report
And it does not save a snapshot

### Scenario: Compare health across runs to detect deterioration
Given a previous health snapshot exists from the last run
And a campaign that was healthy last run now has a reply rate below the threshold
When the campaign health monitor runs
Then it flags the campaign as "declining" in addition to "low reply rate"
And the alert includes the previous reply rate for context: "Reply rate dropped from {prev}% to {current}%"

### Scenario: Campaign recovers from previous alert
Given a previous health snapshot flagged campaign "Rebound Campaign" as stalled
And the campaign has sent new messages since then
When the campaign health monitor runs
Then it marks "Rebound Campaign" as "recovered"
And the report includes "Campaign 'Rebound Campaign' is active again — previously flagged as stalled"

### Scenario: Store health snapshot for future comparison
Given the campaign health monitor runs successfully
When the report is complete
Then it saves a snapshot to `data/health-snapshots/{date}.json`
And the snapshot includes: date, campaign IDs with their alert statuses, reply rates, and last-send timestamps
And the snapshot can be loaded on the next run for comparison

### Scenario: Schedule campaign health monitor via cron
Given `CAMPAIGN_HEALTH_CRON` is set to `0 9 * * *` (daily at 9am)
When the automation scheduler evaluates the cron expression
Then it runs the campaign health monitor at the configured time
And it outputs the health report for the founder to review

## Output Format

```
=== Campaign Health Check ({date}) ===

Status: {n} active campaigns checked — {n_alerts} issues found

--- Alerts ---
  ⚠️  "{campaign_name}" — Stalled: no sends in {n} days
  ⚠️  "{campaign_name}" — Low reply rate: {rate}% after {sent} sends (was {prev_rate}%)
  ✅  "{campaign_name}" — Recovered: active again after stall

--- Campaign Summary ---
  "{name}": {sent} sent, {reply_rate}% reply rate — {status}
  "{name}": {sent} sent, {reply_rate}% reply rate — {status}
  "{name}": too early ({sent}/{min_sends} sends)

--- What to Do ---
  {next_action}

Next health check: {next_run_date}
```

When all campaigns are healthy:

```
=== Campaign Health Check ({date}) ===

All campaigns healthy — no issues detected

--- Campaign Summary ---
  "{name}": {sent} sent, {reply_rate}% reply rate — healthy
  "{name}": {sent} sent, {reply_rate}% reply rate — healthy

Next health check: {next_run_date}
```

## Function Signature

```typescript
export type AlertSeverity = 'warning' | 'info';

export type AlertType = 'stalled' | 'low_reply_rate' | 'declining' | 'recovered' | 'too_early';

export interface CampaignAlert {
  campaignId: string;
  campaignName: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
}

export interface CampaignHealthStatus {
  campaignId: string;
  campaignName: string;
  status: string;
  sent: number;
  replyRate: number;
  lastSendEstimate: string | null;
  alerts: CampaignAlert[];
}

export interface HealthSnapshot {
  date: string;
  campaigns: Array<{
    id: string;
    alerts: AlertType[];
    replyRate: number;
    sent: number;
  }>;
}

export interface CampaignHealthReport {
  date: string;
  campaignsChecked: number;
  alerts: CampaignAlert[];
  campaignStatuses: CampaignHealthStatus[];
  recoveries: CampaignAlert[];
  reportText: string;
  snapshot: HealthSnapshot;
}

type HealthMonitorClient = Pick<GojiBerryClient, 'getCampaigns'>;

export async function checkCampaignHealth(options?: {
  _client?: HealthMonitorClient;
  _snapshotDir?: string;
  stallThresholdDays?: number;
  lowReplyRateThreshold?: number;
  minSendsForAnalysis?: number;
}): Promise<CampaignHealthReport>;
```

## Dependencies

- `GojiBerryClient.getCampaigns()` — fetches all campaigns with metrics and status
- `Campaign` type from `src/api/types.ts` — has `status`, `metrics`, `updatedAt`
- `analyzeCampaignPerformance()` from `src/automations/campaign-performance-analytics.ts` — reuse `CampaignMetrics` computation for reply rate derivation
- `fs` for reading/writing health snapshots to `data/health-snapshots/`

## Design Decisions

1. **Stall detection via `updatedAt`**: The campaign `updatedAt` timestamp is the best proxy for "last activity." The API doesn't expose a `lastSendAt` field, so we use `updatedAt` as the last-send estimate. If `updatedAt` is absent, the campaign is treated as "unknown activity date" and not flagged for stalling.

2. **Thresholds are configurable, not hardcoded**: Different founders have different tolerances. A founder running 2 campaigns might care about 3-day stalls; an agency running 20 might only flag 7-day stalls. All thresholds come from env vars with sensible defaults.

3. **Alerts, not actions**: The monitor reports problems — it never pauses, resumes, or modifies campaigns. The founder decides what to do. This respects the "human-in-the-loop" design principle.

4. **Snapshot comparison for trend detection**: Same pattern as weekly report and morning briefing — JSON snapshots named by date, lexicographic sort to find the most recent. Enables "declining" and "recovered" alerts without a database.

5. **Small scope (S complexity)**: This is a thin automation — fetch campaigns, apply threshold checks, compare to last snapshot, format report. No new API endpoints or data models needed beyond what Feature 11 already established.
