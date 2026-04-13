---
feature: Warm Lead List Builder
domain: intelligence-layer
source: src/automations/warm-lead-list-builder.ts
tests:
  - tests/automations/warm-lead-list-builder.test.ts
components: []
design_refs: []
status: implemented
created: 2026-04-13
updated: 2026-04-13
---

# Warm Lead List Builder

**Source File**: src/automations/warm-lead-list-builder.ts
**Design System**: N/A (no UI — automation script)
**Depends on**: GojiBerry API Client (`src/api/gojiberry-client.ts`), Lead Enrichment (Feature 3)

## Overview

Combines score filtering (`scoreFrom`/`scoreTo`), date filtering (`dateFrom`/`dateTo`), and intent type filtering to surface the hottest leads from GojiBerry. Outputs a prioritized list sorted by fit score (highest first) with a human-readable "reason for warmth" for each lead — drawn from their intent signals and fit score.

This is Feature 13 in the roadmap (Phase 2: Intelligence Layer). The founder wants a single command that answers: "Who should I reach out to right now, and why?"

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOJIBERRY_API_KEY` | Yes | Bearer token for GojiBerry API |
| `MIN_INTENT_SCORE` | No | Minimum score threshold (default: 50) |

## Feature: Warm Lead List Builder

### Scenario: Build a warm lead list with default filters
Given the founder has enriched leads in GojiBerry with fit scores
And no custom filters are provided
When the warm lead list builder runs
Then it fetches leads with `scoreFrom` set to `MIN_INTENT_SCORE` (default 50)
And sorts results by fit score descending (highest first)
And generates a "reason for warmth" for each lead from their intent signals and score tier
And outputs a prioritized list with lead name, company, score, intent type, and reason

### Scenario: Build a warm lead list with custom score range
Given the founder provides `scoreFrom: 80` and `scoreTo: 100`
When the warm lead list builder runs
Then it fetches only leads with fit scores between 80 and 100
And labels all returned leads as "Hot" tier
And outputs the prioritized list

### Scenario: Build a warm lead list filtered by date range
Given the founder provides `dateFrom: "2026-04-01"` and `dateTo: "2026-04-13"`
When the warm lead list builder runs
Then it fetches only leads created or updated within that date range
And applies the default score threshold
And outputs the prioritized list with dates included

### Scenario: Build a warm lead list filtered by intent type
Given the founder provides `intentType: "hiring"`
When the warm lead list builder runs
Then it fetches only leads tagged with the "hiring" intent type
And applies the default score threshold
And outputs the prioritized list grouped by that intent type

### Scenario: Combine all filters
Given the founder provides score range, date range, and intent type filters
When the warm lead list builder runs
Then it passes all filters to `searchLeads()` in a single API call
And the returned leads satisfy all filter criteria simultaneously
And outputs the prioritized list

### Scenario: Paginate through large result sets
Given GojiBerry has more warm leads than fit in a single page
When the warm lead list builder runs
Then it fetches page 1 and checks if `total > page * pageSize`
And continues fetching subsequent pages until all matching leads are collected
And combines all pages into a single sorted list

### Scenario: Generate reason-for-warmth per lead
Given a lead has `fitScore: 85` and `intentSignals: ["Recently raised Series B", "Hiring 3 SDRs"]`
When the warm lead list builder formats that lead
Then the reason includes the score tier ("Hot")
And the reason includes all intent signals as bullet points
And the reason reads naturally, e.g. "Hot lead (score: 85) — Recently raised Series B, Hiring 3 SDRs"

### Scenario: Handle leads with no intent signals
Given a lead has a fit score above the threshold but no intent signals
When the warm lead list builder formats that lead
Then the reason includes only the score tier and score value
And notes "No specific intent signals recorded — scored on ICP fit alone"

### Scenario: Handle zero matching leads
Given no leads in GojiBerry match the applied filters
When the warm lead list builder runs
Then it outputs "No warm leads found matching your criteria"
And returns an empty list result
And does not error

### Scenario: Handle API authentication failure
Given the `GOJIBERRY_API_KEY` is invalid or expired
When the warm lead list builder runs
Then it throws an `AuthError` from the API client
And does not output a partial list

## Output Format

The report is a plain-text summary designed for quick scanning:

```
=== Warm Lead List ===

Filters: score >= 50, all dates, all intent types
Found: {count} warm leads

--- Hot (80-100) — {count} leads ---
  1. {firstName} {lastName} ({company}) — Score: {fitScore}
     {jobTitle} | {intentType}
     Why warm: {reason_for_warmth}

--- Warm (50-79) — {count} leads ---
  2. {firstName} {lastName} ({company}) — Score: {fitScore}
     {jobTitle} | {intentType}
     Why warm: {reason_for_warmth}

No cool or cold leads included (below threshold).
```

## Function Signature

```typescript
export interface WarmLeadFilters {
  scoreFrom?: number;
  scoreTo?: number;
  dateFrom?: string;
  dateTo?: string;
  intentType?: string;
}

export interface WarmLead {
  id: string;
  firstName: string;
  lastName: string;
  company: string;
  jobTitle: string;
  profileUrl: string;
  fitScore: number;
  intentType: string;
  intentSignals: string[];
  scoreTier: 'hot' | 'warm';
  reasonForWarmth: string;
}

export interface WarmLeadListResult {
  leads: WarmLead[];
  filters: {
    scoreFrom: number;
    scoreTo: number;
    dateFrom?: string;
    dateTo?: string;
    intentType?: string;
  };
  byTier: {
    hot: WarmLead[];
    warm: WarmLead[];
  };
  total: number;
  reportText: string;
}

export async function buildWarmLeadList(
  filters?: WarmLeadFilters,
  options?: { _client?: GojiBerryClient },
): Promise<WarmLeadListResult>;
```

## Dependencies

- `GojiBerryClient.searchLeads(filters)` — fetches paginated, filtered leads
- `LeadFilters` type from `src/api/types.ts` — supports `scoreFrom`, `scoreTo`, `dateFrom`, `dateTo`, `intentType`
- `Lead` type from `src/api/types.ts` — has `fitScore`, `intentSignals`, `intentType`
- `MIN_INTENT_SCORE` from `.env.local` — default score threshold

## Score Tiers

Consistent with pipeline overview report:
- **Hot**: 80-100
- **Warm**: 50-79
- **Cool**: 20-49 (excluded by default threshold)
- **Cold**: 0-19 (excluded by default threshold)

## Learnings

### `Record<string, unknown>` for optional filter accumulation

Build the API filter object by conditionally assigning keys only when they're present, using a `Record<string, unknown>` base type:

```ts
const apiFilters: Record<string, unknown> = { scoreFrom: minScore, scoreTo: maxScore };
if (filters?.dateFrom) apiFilters.dateFrom = filters.dateFrom;
if (filters?.dateTo) apiFilters.dateTo = filters.dateTo;
if (filters?.intentType) apiFilters.intentType = filters.intentType;
```

This avoids having `undefined` values in the object (which some APIs treat differently from absent keys) and keeps the intent explicit. Cast to the final API filter type at the call site.

### Env-dependent defaults: use floor assertions not exact values

When a function reads a numeric config from `process.env`, tests can't know whether `.env.local` sets it to 50 or 60. Use `toBeGreaterThanOrEqual(minDefault)` instead of `toBe(exactValue)` to stay green across environments:

```ts
// Fragile — breaks when .env.local overrides MIN_INTENT_SCORE
expect(result.filters.scoreFrom).toBe(50);

// Resilient — passes whether env value is 50, 60, or any valid override
expect(result.filters.scoreFrom).toBeGreaterThanOrEqual(50);
```

Add a comment explaining the two possible values so future readers understand the range assertion isn't laziness.

### Separate `makeMockClientThrowing` factory for error-path tests

A distinct factory for error-path client mocks keeps tests readable — avoids repeating `.mockRejectedValue(error)` inline across every error test:

```ts
function makeMockClientThrowing(error: Error): MockClient {
  return { searchLeads: vi.fn().mockRejectedValue(error) };
}

// Test:
const client = makeMockClientThrowing(new AuthError());
await expect(buildWarmLeadList(undefined, { _client: client })).rejects.toThrow(AuthError);
```

Pairs naturally with `makeMockClient(pages[])` for the happy path.
