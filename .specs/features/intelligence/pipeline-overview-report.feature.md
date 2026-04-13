---
feature: Pipeline Overview Report
domain: intelligence
source: src/automations/pipeline-overview-report.ts
tests:
  - tests/automations/pipeline-overview-report.test.ts
components: []
design_refs: []
status: implemented
created: 2026-04-13
updated: 2026-04-13
---

# Pipeline Overview Report

**Source File**: src/automations/pipeline-overview-report.ts
**Depends On**: GojiBerry API Client (Feature 1)

## Overview

On-demand automation that pulls contact, campaign, and intent data from the GojiBerry API and produces a plain-English pipeline summary. Designed to be called by Claude or a scheduled task to give the user a quick snapshot of their outreach pipeline health.

## Feature: Pipeline Overview Report

### Scenario: Generate a complete pipeline overview
Given the GojiBerry API is reachable
And the account has contacts, campaigns, and intent data
When the pipeline overview report is generated
Then the report includes total contact count
And the report includes a breakdown of contacts by intent type
And the report includes total campaign count with status breakdown
And the report includes a plain-English summary paragraph

### Scenario: Generate report with score tier breakdown
Given the GojiBerry API is reachable
And the account has contacts with varying fit scores
When the pipeline overview report is generated
Then the report includes contacts grouped by score tier
And the tiers are "Hot" (80-100), "Warm" (50-79), "Cool" (20-49), "Cold" (0-19)

### Scenario: Generate report with campaign metrics
Given the GojiBerry API is reachable
And the account has campaigns with metrics (sent, opened, replied, converted)
When the pipeline overview report is generated
Then the report includes aggregate campaign metrics
And the report includes per-campaign status and performance

### Scenario: Handle empty pipeline gracefully
Given the GojiBerry API is reachable
And the account has no contacts and no campaigns
When the pipeline overview report is generated
Then the report indicates zero contacts
And the report indicates zero campaigns
And the summary describes an empty pipeline

### Scenario: Handle partial data (contacts but no campaigns)
Given the GojiBerry API is reachable
And the account has contacts but no campaigns
When the pipeline overview report is generated
Then the report includes contact data normally
And the campaign section indicates no active campaigns

### Scenario: Handle API unreachable
Given the GojiBerry API is not reachable
When the pipeline overview report is generated
Then the report generation fails with a clear error message
And the error indicates the API could not be reached

### Scenario: Handle API authentication failure
Given the GojiBerry API key is invalid
When the pipeline overview report is generated
Then the report generation fails with an authentication error

### Scenario: Lists data is included in the report
Given the GojiBerry API is reachable
And the account has lists with contacts assigned to them
When the pipeline overview report is generated
Then the report includes the total number of lists
And the report includes the total number of leads across all lists

## Data Sources

The report aggregates data from these GojiBerry API endpoints:

| Endpoint | Purpose | Client Method |
|----------|---------|---------------|
| `GET /v1/contact` | Total contacts + paginated list | `searchLeads()` |
| `GET /v1/contact/intent-type-counts` | Intent type breakdown | `getIntentTypeCounts()` |
| `GET /v1/campaign` | All campaigns + status/metrics | `getCampaigns()` |
| `GET /v1/list` | Lists with contact counts | `getLists()` |

## Report Structure

```
PipelineOverviewReport {
  generatedAt: string              // ISO timestamp
  contacts: {
    total: number
    byIntentType: Record<string, number>
    byScoreTier: {
      hot: number                  // 80-100
      warm: number                 // 50-79
      cool: number                 // 20-49
      cold: number                 // 0-19
      unscored: number             // no fitScore
    }
  }
  campaigns: {
    total: number
    byStatus: Record<string, number>  // active, paused, completed, draft
    metrics: {
      totalSent: number
      totalOpened: number
      totalReplied: number
      totalConverted: number
    }
  }
  lists: {
    total: number
    totalLeadsInLists: number
  }
  summary: string                  // Plain-English paragraph
}
```

## Summary Generation

The plain-English summary should read like a brief:

> "Your pipeline has 142 contacts — 23 hot, 45 warm, 50 cool, 20 cold, and 4 unscored. The top intent type is 'hiring' with 38 contacts. You have 3 campaigns: 2 active, 1 completed. Across all campaigns, 500 messages sent with a 12% reply rate."

Key rules:
- Always include contact total and score tier breakdown
- Always mention the top intent type (or "no intent data" if empty)
- Always include campaign count and status
- Include reply rate if any messages have been sent (replied / sent * 100)
- 2 sentences minimum, 4 sentences maximum (reply rate adds a 4th when applicable)

## Function Signature

```typescript
export async function generatePipelineOverview(
  client: GojiBerryClient,
): Promise<PipelineOverviewReport>
```

- Single dependency: an initialized `GojiBerryClient`
- Returns the structured report object (summary included)
- Throws on API errors (auth, network) — caller handles retries

## Learnings

1. **`Promise.all()` for parallel API fan-out**: All four endpoints (`searchLeads`, `getIntentTypeCounts`, `getCampaigns`, `getLists`) are independent — fan them out in a single `Promise.all()`. Any failure propagates immediately (fail-fast). Sequential calls would be ~4× slower for no reason.

2. **`do...while` for pagination**: `do { fetch page; push; page++ } while (allLeads.length < total)` always fetches at least page 1, then continues until complete. Cleaner than a while-with-pre-check and avoids off-by-one when total is 0 (the loop runs once, gets empty results, and exits).

3. **Pure function aggregation after async fetch**: `fetchAllLeads`, `computeScoreTiers`, `aggregateCampaigns`, `aggregateLists`, and `generateSummary` are all pure functions that operate on already-fetched data. This split makes each step independently unit-testable without any async machinery.

4. **Guard both `undefined` and `null` for optional API numeric fields**: `classifyScoreTier` checks `score === undefined || score === null` because the GojiBerry API may return `null` explicitly or omit the field entirely. A single `score == null` (loose equality) or `score === undefined` check is not enough.

5. **`PipelineClient` Pick<> alias narrows mock surface**: The internal `fetchAllLeads` helper types its client as `Pick<GojiBerryClient, 'searchLeads' | 'getIntentTypeCounts' | 'getCampaigns' | 'getLists'>`. Test mocks only need to implement those four methods — not the full client interface.
