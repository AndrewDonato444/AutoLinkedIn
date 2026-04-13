---
feature: Morning Briefing
domain: automation
source: src/automations/morning-briefing.ts
tests:
  - tests/automations/morning-briefing.test.ts
components: []
design_refs: []
status: specced
created: 2026-04-13
updated: 2026-04-13
---

# Morning Briefing

**Source File**: src/automations/morning-briefing.ts
**Depends On**: Pipeline Overview Report (Feature 10), Warm Lead List Builder (Feature 13)

## Overview

Daily scheduled automation (cron via `MORNING_BRIEFING_CRON`) that combines the pipeline overview and warm lead list into a single digest the founder scans over coffee. Answers: "What happened overnight, who's hot right now, and what should I do first?"

The founder doesn't want to run two separate reports and piece them together. This is the "open your laptop, read one thing, know what to do" moment.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOJIBERRY_API_KEY` | Yes | — | Bearer token for GojiBerry API |
| `MORNING_BRIEFING_CRON` | No | `0 8 * * 1-5` | Cron schedule (default: weekdays at 8am) |
| `MORNING_BRIEFING_TOP_LEADS` | No | `5` | Number of top warm leads to highlight |
| `MIN_INTENT_SCORE` | No | `50` | Minimum score for warm leads (passed to warm lead list builder) |

## Feature: Morning Briefing

### Scenario: Generate a complete morning briefing with pipeline and warm leads
Given the founder has leads and campaigns in GojiBerry
And the `GOJIBERRY_API_KEY` is configured
When the morning briefing runs
Then it calls `generatePipelineOverview()` for the pipeline snapshot
And it calls `buildWarmLeadList()` for the hottest leads
And it combines both into a single briefing
And the briefing opens with a one-line pipeline summary
And it lists the top warm leads with reason-for-warmth
And it ends with a clear next action ("Open GojiBerry to approve messages" or "No action needed today")

### Scenario: Briefing highlights overnight changes
Given the previous briefing's pipeline snapshot is stored
And new leads were added since the last briefing
When the morning briefing runs
Then it compares current pipeline totals to the previous snapshot
And it reports deltas: "+{n} new leads since yesterday", "{n} newly warm"
And it calls out any leads that crossed into "Hot" tier since last briefing

### Scenario: First briefing with no previous snapshot
Given this is the first time the morning briefing runs
And there is no stored previous briefing snapshot
When the morning briefing runs
Then it generates the briefing with current data only
And it skips overnight-change deltas (marks them as "first briefing — no comparison yet")
And it still lists the top warm leads and next action

### Scenario: Briefing with warm leads ready for outreach
Given there are warm leads with personalized messages already generated
When the morning briefing runs
Then it flags those leads as "messages ready — approve in GojiBerry"
And the next action says "You have {n} leads with messages ready. Open GojiBerry to review and approve."

### Scenario: Briefing with warm leads but no messages yet
Given there are warm leads above the intent threshold
But none of them have personalized messages generated
When the morning briefing runs
Then it lists the warm leads normally
And the next action says "Top leads need messages — run message generation or wait for the daily scan"

### Scenario: Empty pipeline — no leads, no campaigns
Given GojiBerry has no leads and no campaigns
When the morning briefing runs
Then it outputs "Your pipeline is empty — no leads or campaigns yet"
And the next action says "Define your ICP and run a lead scan to get started"
And it returns the briefing with zero-state content

### Scenario: Leads exist but none are warm
Given GojiBerry has leads but all are below the warm threshold
When the morning briefing runs
Then the pipeline summary shows the total lead count and score breakdown
And the warm leads section says "No warm leads right now — {n} leads scored below {threshold}"
And the next action says "Consider enriching more leads or adjusting your ICP"

### Scenario: Top leads are capped at configured limit
Given there are 20 warm leads in GojiBerry
And `MORNING_BRIEFING_TOP_LEADS` is set to 5
When the morning briefing runs
Then it includes only the top 5 leads by fit score
And it notes "{remaining} more warm leads not shown — run the full warm lead report for the complete list"

### Scenario: Handle API authentication failure
Given the `GOJIBERRY_API_KEY` is invalid or expired
When the morning briefing runs
Then it throws an `AuthError` from the underlying API calls
And it does not output a partial briefing
And it does not save a snapshot

### Scenario: Handle partial API failure (pipeline succeeds, warm leads fail)
Given the pipeline overview API calls succeed
But the warm lead list API call fails with a network error
When the morning briefing runs
Then it includes the pipeline summary in the briefing
And it marks the warm leads section as "Could not fetch warm leads — check API connectivity"
And it still outputs the briefing (partial data is better than nothing)

### Scenario: Store briefing snapshot for overnight comparison
Given the morning briefing runs successfully
When the briefing is complete
Then it saves a snapshot to `data/briefing-snapshots/{date}.json`
And the snapshot includes: date, total leads, leads by tier, campaign count, top lead IDs
And the snapshot can be loaded on the next run for overnight comparison

### Scenario: Schedule morning briefing via cron
Given `MORNING_BRIEFING_CRON` is set to `0 8 * * 1-5` (weekdays at 8am)
When the automation scheduler evaluates the cron expression
Then it runs the morning briefing at the configured time
And it outputs the briefing for the founder to review

## Output Format

```
=== Morning Briefing ({date}) ===

Pipeline: {total_leads} leads — {hot} hot, {warm} warm, {cool} cool, {cold} cold
          {campaigns_active} active campaigns, {total_sent} messages sent
Overnight: +{new_leads} new leads, {newly_warm} crossed into warm
           ({or "first briefing — no comparison yet"})

--- Top {n} Leads Right Now ---
  1. {firstName} {lastName} ({company}) — Score: {fitScore} [{tier}]
     {jobTitle} | Intent: {intentType}
     Why warm: {reason_for_warmth}
     {status: "Messages ready — approve in GojiBerry" | "Needs messages"}

  2. ...

  ({remaining} more warm leads — run full warm lead report for complete list)

--- What to Do ---
  {next_action}

Next briefing: {next_run_date}
```

## Function Signature

```typescript
export interface BriefingSnapshot {
  date: string;
  totalLeads: number;
  byTier: {
    hot: number;
    warm: number;
    cool: number;
    cold: number;
    unscored: number;
  };
  campaignCount: number;
  topLeadIds: string[];
}

export interface OvernightChanges {
  newLeads: number;
  newlyWarm: number;
  previousSnapshot: BriefingSnapshot | null;
}

export interface MorningBriefing {
  date: string;
  pipeline: PipelineOverviewReport;
  topLeads: WarmLead[];
  totalWarmLeads: number;
  overnightChanges: OvernightChanges;
  leadsWithMessages: number;
  nextAction: string;
  briefingText: string;
  snapshot: BriefingSnapshot;
}

type BriefingClient = Pick<GojiBerryClient, 'searchLeads' | 'getIntentTypeCounts' | 'getCampaigns' | 'getLists'>;

export async function generateMorningBriefing(options?: {
  _client?: BriefingClient;
  _snapshotDir?: string;
  topLeadsCount?: number;
}): Promise<MorningBriefing>;
```

## Dependencies

- `generatePipelineOverview()` from `src/automations/pipeline-overview-report.ts` — pipeline snapshot
- `PipelineOverviewReport` type from the same module
- `buildWarmLeadList()` from `src/automations/warm-lead-list-builder.ts` — warm leads
- `WarmLead`, `WarmLeadListResult` types from the same module
- `GojiBerryClient` from `src/api/gojiberry-client.ts`
- `fs` for reading/writing briefing snapshots to `data/briefing-snapshots/`

## Snapshot Storage

Briefing snapshots are stored as JSON files in `data/briefing-snapshots/`:

```
data/briefing-snapshots/
  2026-04-13.json
  2026-04-14.json
  ...
```

Each file contains a `BriefingSnapshot` object. On each run, the automation:
1. Looks for the most recent snapshot file (by date in filename, lexicographic sort)
2. Compares against current data for overnight deltas
3. Saves a new snapshot after generating the briefing

The `_snapshotDir` option in the function signature allows tests to use a temp directory.

## Design Decisions

1. **Partial failure tolerance**: Unlike the weekly report (which aborts on API failure), the morning briefing shows whatever data it can gather. The founder checking their phone at 8am wants _something_ — a pipeline summary with "warm leads unavailable" beats a blank screen.

2. **Compose, don't duplicate**: Calls existing `generatePipelineOverview()` and `buildWarmLeadList()` instead of re-fetching from the API. If those functions evolve, the briefing inherits improvements automatically.

3. **Overnight changes via snapshot diff**: Simple file-based snapshot comparison (same pattern as weekly report). No database needed — just JSON files named by date.

4. **Next action is always concrete**: Every briefing ends with one clear thing to do. Not "review your pipeline" but "You have 3 leads with messages ready. Open GojiBerry to approve."

## Learnings

(To be filled after implementation)
