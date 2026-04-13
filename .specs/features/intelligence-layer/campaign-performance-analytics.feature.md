---
feature: Campaign Performance Analytics
domain: intelligence-layer
source: src/automations/campaign-performance-analytics.ts
tests:
  - tests/automations/campaign-performance-analytics.test.ts
components: []
design_refs: []
status: implemented
created: 2026-04-13
updated: 2026-04-13
---

# Campaign Performance Analytics

**Source File**: src/automations/campaign-performance-analytics.ts
**Design System**: N/A (no UI — automation script)
**Depends on**: GojiBerry API Client (`src/api/gojiberry-client.ts`)

## Overview

Pulls all campaigns from GojiBerry, computes performance metrics (reply rate, open rate, conversion rate), compares active vs. completed campaigns, and identifies patterns. Generates a plain-English report the founder can scan in under a minute: what worked, what didn't, reply rate trends, and which lead segments convert best.

This is Feature 11 in the roadmap (Phase 2: Intelligence Layer). The founder wants to know "is my outreach actually working?" without digging through campaign dashboards manually.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOJIBERRY_API_KEY` | Yes | Bearer token for GojiBerry API |

## Feature: Campaign Performance Analytics

### Scenario: Generate performance report for all campaigns
Given the founder has campaigns in GojiBerry with metrics data
When the campaign performance analytics automation runs
Then it fetches all campaigns from GojiBerry via `GET /v1/campaign`
And computes derived metrics for each campaign:
  - Reply rate: `replied / sent * 100`
  - Open rate: `opened / sent * 100`
  - Conversion rate: `converted / sent * 100`
And ranks campaigns by reply rate (highest first)
And outputs a summary report with per-campaign metrics and overall averages

### Scenario: Compare active vs. completed campaigns
Given GojiBerry has both active and completed campaigns
When the analytics automation runs
Then it groups campaigns by status (active, completed, paused, draft)
And computes aggregate metrics for each status group
And highlights if active campaigns are outperforming or underperforming completed ones
And includes the comparison in the report

### Scenario: Identify top-performing and underperforming campaigns
Given there are multiple campaigns with varying reply rates
When the analytics automation runs
Then it identifies the campaign with the highest reply rate as "top performer"
And identifies the campaign with the lowest reply rate (with at least 1 sent) as "needs attention"
And includes these highlights in the report summary

### Scenario: Handle campaigns with no sends
Given a campaign exists with 0 messages sent (draft or just created)
When computing metrics for that campaign
Then it sets reply rate, open rate, and conversion rate to 0
And marks the campaign as "no data yet" in the report
And does not include it in average calculations

### Scenario: Handle zero campaigns
Given GojiBerry returns no campaigns
When the analytics automation runs
Then it outputs "No campaigns found in GojiBerry — launch a campaign first to see analytics"
And returns an empty report object

### Scenario: Handle API authentication failure
Given the `GOJIBERRY_API_KEY` is invalid or expired
When the analytics automation runs
Then it throws an `AuthError` from the API client
And does not output a partial report

### Scenario: Generate trend insights from completed campaigns
Given there are multiple completed campaigns with metrics
When the analytics automation runs
Then it computes the overall average reply rate across all completed campaigns
And notes if the most recent completed campaign performed above or below the average
And includes a trend line indicator: "improving", "declining", or "stable"

### Scenario: Single campaign exists
Given only one campaign exists in GojiBerry
When the analytics automation runs
Then it outputs metrics for that single campaign
And skips comparative analysis (no peers to compare)
And skips trend analysis (insufficient data)

## Output Format

The report is a plain-text summary designed for quick scanning:

```
=== Campaign Performance Report ===

Overall: {total_campaigns} campaigns, {total_sent} messages sent, {avg_reply_rate}% avg reply rate

Top Performer: "{campaign_name}" — {reply_rate}% reply rate ({replied}/{sent})
Needs Attention: "{campaign_name}" — {reply_rate}% reply rate ({replied}/{sent})

--- Active Campaigns ({count}) ---
  {name}: {sent} sent, {open_rate}% opened, {reply_rate}% replied, {conversion_rate}% converted

--- Completed Campaigns ({count}) ---
  {name}: {sent} sent, {open_rate}% opened, {reply_rate}% replied, {conversion_rate}% converted

--- Trend ---
Reply rate trend: {improving|declining|stable} (latest: {latest}%, avg: {avg}%)
```

## Function Signature

```typescript
export interface CampaignReport {
  campaigns: CampaignMetrics[];
  topPerformer: CampaignMetrics | null;
  needsAttention: CampaignMetrics | null;
  byStatus: Record<string, CampaignMetrics[]>;
  overallAverages: {
    replyRate: number;
    openRate: number;
    conversionRate: number;
    totalSent: number;
  };
  trend: 'improving' | 'declining' | 'stable' | 'insufficient_data';
  reportText: string;
}

export interface CampaignMetrics {
  id: string;
  name: string;
  status: string;
  sent: number;
  opened: number;
  replied: number;
  converted: number;
  replyRate: number;
  openRate: number;
  conversionRate: number;
}

export async function analyzeCampaignPerformance(options?: {
  _client?: GojiBerryClient;
}): Promise<CampaignReport>;
```

## Dependencies

- `GojiBerryClient.getCampaigns()` — fetches all campaigns with metrics
- `Campaign` type from `src/api/types.ts` — has `metrics: { sent, opened, replied, converted }`

## Learnings

### Sort for display vs. sort for analysis — keep original order for trend

`allMetrics` is sorted by reply rate (highest first) for display. But `computeTrend` needs the campaigns in **original API order** (creation order = chronological). Passing the sorted array to trend analysis would make "latest" always the lowest-reply campaign, making the trend always appear declining.

Fix: filter `completedCampaigns` from `allMetrics` (pre-sort), then pass both the sorted list and the unsorted completed list separately to `buildReportText`.

### `needsAttention` is null when ≤1 campaign has sends

With exactly one campaign that has sends, that campaign is the top performer. Assigning it to `needsAttention` too would surface the same campaign under two contradictory labels. Guard with `withSends.length > 1`:

```ts
const needsAttention = withSends.length > 1 ? withSends[withSends.length - 1] : null;
```

### Zero-send campaigns: include in status groups, exclude from all metric computations

Draft/new campaigns with `sent === 0` still appear in `byStatus` groups (shown as "no data yet" in the report), but are excluded from `withSends` for averages, rankings, and trend. This is the correct UX split: the founder sees the campaign exists, but it doesn't pollute analytics.

### `metrics ??` guard for campaigns with no metrics field

Draft campaigns may omit `metrics` entirely (field is absent, not `{}`). The `??` guard provides a safe zero fallback without an extra `if`:

```ts
const m = campaign.metrics ?? { sent: 0, opened: 0, replied: 0, converted: 0 };
```

### `Pick<>` on the function signature eliminates cast in tests

Using `type AnalyticsClient = Pick<GojiBerryClient, 'getCampaigns'>` as the parameter type (not just in the mock type) means any object with a `getCampaigns` method satisfies it. The test `MockClient` type satisfies `AnalyticsClient` structurally — no `as unknown as GojiBerryClient` cast needed anywhere.
