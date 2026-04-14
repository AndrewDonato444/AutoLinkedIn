---
feature: Intent Type Breakdown
domain: intelligence-layer
source: src/automations/intent-type-breakdown.ts
tests:
  - tests/automations/intent-type-breakdown.test.ts
components: []
design_refs: []
status: stub
created: 2026-04-13
updated: 2026-04-13
---

# Intent Type Breakdown

**Source File**: src/automations/intent-type-breakdown.ts
**Design System**: N/A (no UI — automation script)
**Depends on**: GojiBerry API Client (`src/api/gojiberry-client.ts`)

## Overview

Fetches intent type counts from GojiBerry, correlates each intent type with campaign reply/conversion performance by pulling contacts per type and matching them against campaign metrics. Produces a report showing which intent types drive real engagement vs. noise, so the founder can focus discovery on high-performing signals.

This is Feature 12 in the roadmap (Phase 2: Intelligence Layer). The founder wants to know "which intent signals are actually worth pursuing?" without manually cross-referencing contact lists and campaign results.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOJIBERRY_API_KEY` | Yes | Bearer token for GojiBerry API |

## Feature: Intent Type Breakdown

### Scenario: Generate intent type breakdown report
Given the founder has contacts in GojiBerry with intent types assigned
When the intent type breakdown automation runs
Then it fetches intent type counts via `GET /v1/contact/intent-type-counts`
And fetches all contacts via paginated `GET /v1/contact`
And fetches all campaigns via `GET /v1/campaign`
And groups contacts by intent type
And for each intent type computes:
  - Total contacts with that type
  - Average fit score of contacts with that type
  - Score tier distribution (hot/warm/cool/cold/unscored)
And outputs a structured report with per-type metrics and a plain-English summary

### Scenario: Correlate intent types with campaign reply rates
Given contacts have intent types and campaigns have reply metrics
When the automation computes cross-referencing metrics
Then for each intent type it estimates engagement potential based on the average fit score of contacts in that type
And ranks intent types by average fit score (highest first)
And identifies the top-performing intent type and the lowest-performing one
And includes a recommendation: "Focus discovery on '{top_type}' — highest average fit score"

### Scenario: Identify noise intent types
Given some intent types have contacts with low average fit scores
When the automation analyzes intent types
Then it flags intent types where the average fit score is below 30 as "low signal"
And flags intent types where all contacts are unscored as "needs scoring"
And includes these flags in the report output

### Scenario: Handle single intent type
Given all contacts share the same intent type
When the automation runs
Then it outputs metrics for that single type
And skips comparative analysis (no peers to compare)
And notes "Only one intent type in pipeline — consider diversifying discovery"

### Scenario: Handle no intent data
Given `getIntentTypeCounts()` returns an empty object
When the automation runs
Then it outputs "No intent data available — enrich contacts with intent types first"
And returns a report with empty type breakdown

### Scenario: Handle contacts with no intent type
Given some contacts have no `intentType` field
When grouping contacts by intent type
Then contacts without an intent type are grouped under "unclassified"
And "unclassified" appears in the breakdown with its own metrics
And it is not included in ranking or recommendations

### Scenario: Handle API authentication failure
Given the `GOJIBERRY_API_KEY` is invalid or expired
When the automation runs
Then it throws an `AuthError` from the API client
And does not output a partial report

### Scenario: Large number of intent types
Given there are more than 10 distinct intent types
When the automation generates the report
Then it shows the top 10 by contact count in the detailed breakdown
And summarizes the remaining types as "and {n} more types with {total} contacts"

## Output Format

The report is a plain-text summary designed for quick scanning:

```
=== Intent Type Breakdown ===

Pipeline: {total_contacts} contacts across {type_count} intent types

--- Top Intent Types (by contact count) ---
  1. {type}: {count} contacts, avg score {avg_score}, {hot} hot / {warm} warm / {cool} cool
  2. {type}: {count} contacts, avg score {avg_score}, {hot} hot / {warm} warm / {cool} cool
  ...

--- Signal Quality ---
  High signal: {types with avg score >= 60}
  Medium signal: {types with avg score 30-59}
  Low signal: {types with avg score < 30}
  Needs scoring: {types with all unscored contacts}

--- Recommendation ---
Focus discovery on '{top_type}' — highest average fit score ({avg}%).
Consider deprioritizing '{bottom_type}' — lowest signal quality.
```

## Function Signature

```typescript
export interface IntentTypeMetrics {
  intentType: string;
  contactCount: number;
  averageFitScore: number | null;
  scoreTiers: {
    hot: number;
    warm: number;
    cool: number;
    cold: number;
    unscored: number;
  };
  signalQuality: 'high' | 'medium' | 'low' | 'needs_scoring';
}

export interface IntentTypeReport {
  generatedAt: string;
  totalContacts: number;
  totalTypes: number;
  types: IntentTypeMetrics[];
  topType: IntentTypeMetrics | null;
  bottomType: IntentTypeMetrics | null;
  reportText: string;
}

type IntentBreakdownClient = Pick<
  GojiBerryClient,
  'getIntentTypeCounts' | 'searchLeads' | 'getCampaigns'
>;

export async function analyzeIntentTypes(options?: {
  _client?: IntentBreakdownClient;
}): Promise<IntentTypeReport>;
```

## Dependencies

- `GojiBerryClient.getIntentTypeCounts()` — fetches `Record<string, number>` of intent types
- `GojiBerryClient.searchLeads()` — fetches paginated contacts with `intentType` and `fitScore`
- `GojiBerryClient.getCampaigns()` — fetches campaigns (for future correlation enhancements)

## Learnings
