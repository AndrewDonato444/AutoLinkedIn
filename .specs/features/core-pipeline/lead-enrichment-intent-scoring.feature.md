---
feature: Lead Enrichment + Intent Scoring
domain: core-pipeline
source: src/automations/lead-enrichment.ts
tests:
  - tests/automations/lead-enrichment.test.ts
components: []
design_refs: []
status: implemented
created: 2026-04-13
updated: 2026-04-13
---

# Lead Enrichment + Intent Scoring

**Source File**: src/automations/lead-enrichment.ts
**Design System**: N/A (no UI — automation script)
**Depends on**: GojiBerry API Client (`src/api/gojiberry-client.ts`), ICP-Based Lead Discovery (feature 2, creates the leads this enriches)

## Overview

Takes existing leads in GojiBerry, researches each one (online activity, recent posts, company news, buying signals), and updates them via `PATCH /v1/contact/{id}` with a fit score and intent signals. Leads that score above the `MIN_INTENT_SCORE` threshold are "warm" — ready for personalized messaging in feature 4.

The founder doesn't want to review 50 leads and discover most are garbage. This automation separates signal from noise so only warm leads get attention.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOJIBERRY_API_KEY` | Yes | Bearer token for GojiBerry API (used by API client) |
| `ANTHROPIC_API_KEY` | Yes | API key for Anthropic (used for web research on each lead) |
| `MIN_INTENT_SCORE` | No | Minimum score (1-100) to consider a lead "warm" (default: 50) |
| `ICP_DESCRIPTION` | Yes | Plain-English ideal customer description — used to evaluate fit |
| `ENRICHMENT_BATCH_SIZE` | No | Max leads to enrich per run (default: 25) |

## Feature: Lead Enrichment + Intent Scoring

### Scenario: Enrich leads with buying signals and fit score
Given the founder has leads in GojiBerry that were discovered but not yet enriched
And `ICP_DESCRIPTION` is set to "Series A SaaS founders in fintech who are actively hiring"
When the lead enrichment automation runs
Then it fetches unenriched leads from GojiBerry
And researches each lead on the web (recent posts, company news, hiring activity, funding rounds)
And assigns a fit score (1-100) based on how well the lead matches the ICP and shows buying signals
And updates each lead in GojiBerry via `PATCH /v1/contact/{id}` with fitScore and intentSignals
And outputs a summary: "{count} leads enriched — {warm_count} are warm (score >= {threshold})"

### Scenario: Identify unenriched leads
Given GojiBerry contains leads with no fitScore set
When the automation fetches leads to enrich
Then it retrieves leads where fitScore is null or undefined
And skips leads that already have a fitScore (already enriched)
And respects `ENRICHMENT_BATCH_SIZE` — processes only that many per run

### Scenario: Reject run when ICP description is missing
Given `ICP_DESCRIPTION` is empty or not set in `.env.local`
When the lead enrichment automation runs
Then it throws a `ConfigError` with message: "Missing ICP_DESCRIPTION in .env.local — describe your ideal customer first"
And no leads are enriched

### Scenario: Research a lead's online activity
Given a lead named "Jane Doe" at "FinPay" with profileUrl "linkedin.com/in/jane-doe"
When the automation researches this lead
Then it searches for recent activity: LinkedIn posts, company news, job postings, funding announcements
And extracts buying signals: hiring for relevant roles, raised funding, expanded to new market, posted about relevant pain points
And produces structured intent signals like: ["Recently raised Series A", "Hiring 3 SDRs", "Posted about outbound challenges"]

### Scenario: Score a lead based on ICP fit and intent
Given the ICP is "Series A SaaS founders in fintech who are actively hiring"
And a lead matches on: SaaS founder, fintech, recently raised Series A, hiring SDRs
When the automation scores this lead
Then the fit score reflects both ICP match (role, industry, stage) and intent strength (buying signals)
And scoring is delegated to Claude (LLM evaluates fit holistically, not a rigid formula)
And the score is an integer from 1 to 100

### Scenario: Apply MIN_INTENT_SCORE threshold for warm classification
Given `MIN_INTENT_SCORE` is set to 60
And a lead receives a fit score of 75
When the enrichment completes
Then the summary classifies this lead as "warm"
And the output groups leads into "warm" (>= 60) and "cold" (< 60)

### Scenario: Use default MIN_INTENT_SCORE when not configured
Given `MIN_INTENT_SCORE` is not set in `.env.local`
When the lead enrichment automation runs
Then it uses a default threshold of 50
And leads scoring 50 or above are classified as warm

### Scenario: Respect enrichment batch size
Given GojiBerry has 40 unenriched leads
And `ENRICHMENT_BATCH_SIZE` is set to 15
When the automation runs
Then it enriches only the first 15 leads (oldest first — FIFO)
And outputs: "15 leads enriched (15 remaining — run again to continue)"

### Scenario: Use default batch size when not configured
Given `ENRICHMENT_BATCH_SIZE` is not set in `.env.local`
When the lead enrichment automation runs
Then it uses a default batch size of 25

### Scenario: Handle web research returning no signals
Given a lead has minimal online presence
When the automation researches this lead
Then it assigns a low fit score based on ICP match alone (profile data from GojiBerry)
And sets intentSignals to an empty array
And logs: "Low signal: {firstName} {lastName} — no buying signals found, scored on profile data only"

### Scenario: Handle GojiBerry API errors during enrichment
Given the automation is enriching 10 leads
And the GojiBerry API returns an error when updating lead #6
When the automation processes the batch
Then it logs: "Failed to update lead: {firstName} {lastName} — {error message}"
And continues enriching the remaining leads
And the summary includes: "8 leads enriched, 1 failed (see logs), 1 skipped"

### Scenario: Handle rate limits during batch enrichment
Given the automation is enriching 25 leads
And each lead requires 1 PATCH call to GojiBerry (plus research calls to Anthropic)
When updating leads approaches the 100 req/min rate limit
Then the GojiBerry API client handles rate limiting automatically
And all leads are enriched without rate limit errors

### Scenario: Handle authentication failure
Given the GojiBerry API key is invalid or expired
When the lead enrichment automation runs
Then it throws an `AuthError` from the API client
And outputs: "GojiBerry API key is invalid or expired — check GOJIBERRY_API_KEY in .env.local"
And no leads are enriched

### Scenario: Output enrichment summary
Given the automation enriched 12 leads with `MIN_INTENT_SCORE` of 50
When the run completes
Then it outputs a summary table with: lead name, company, fit score, top intent signal, warm/cold status
And a totals line: "12 leads enriched — 7 warm, 5 cold (threshold: 50)"
And warm leads are listed first, sorted by score descending

### Scenario: Re-enrich a lead (force refresh)
Given a lead was previously enriched with a fitScore of 45
And the founder wants to re-check this lead for new buying signals
When the automation runs with the `forceRefresh` option enabled
Then it re-researches and re-scores leads even if they already have a fitScore
And updates GojiBerry with the new score and signals (overwrites previous)

### Scenario: Enrich a specific lead by ID
Given the founder wants to enrich a single lead rather than a batch
When the automation runs with a specific lead ID
Then it fetches that lead from GojiBerry via `GET /v1/contact/{id}`
And researches and scores just that lead
And updates it in GojiBerry
And outputs: "{firstName} {lastName} — score: {score}, signals: {signal list}"

## Module Structure

```
src/automations/
├── lead-enrichment.ts      # Main automation — orchestrates fetch + research + update
├── types.ts                # Shared types (extend with enrichment-specific types)
```

## Public API Surface

```typescript
interface IntentResearch {
  fitScore: number;                // 1-100, holistic ICP + intent score
  intentSignals: string[];         // Human-readable buying signals
  reasoning: string;               // Why this score (for debugging/logging)
}

interface EnrichmentResult {
  enriched: { lead: Lead; research: IntentResearch }[];   // Successfully enriched
  failed: { lead: Lead; error: string }[];                // Research or update failures
  skipped: Lead[];                                         // Already enriched (no forceRefresh)
  remaining: number;                                       // Unenriched leads still in GojiBerry
}

type WebResearchFn = (lead: Lead, icpDescription: string) => Promise<IntentResearch>;

async function enrichLeads(options?: {
  leadId?: string;            // Enrich a single lead by ID
  forceRefresh?: boolean;     // Re-enrich already-scored leads
  batchSize?: number;         // Override ENRICHMENT_BATCH_SIZE
  minIntentScore?: number;    // Override MIN_INTENT_SCORE (for summary classification)
  icpDescription?: string;    // Override ICP_DESCRIPTION
  _webResearch?: WebResearchFn;  // Test-only: inject mock research function
  _client?: GojiBerryClient;    // Test-only: inject mock GojiBerry client
}): Promise<EnrichmentResult>
```

## Data Flow

```
1. Read ICP_DESCRIPTION + MIN_INTENT_SCORE from .env.local
           │
2. Fetch unenriched leads from GojiBerry
   (searchLeads where fitScore is null, limited by ENRICHMENT_BATCH_SIZE)
           │
3. For each lead:
   ├── Research on web (Claude with web search tool)
   │   └── Recent posts, company news, hiring, funding, pain points
   ├── Score: Claude evaluates ICP fit + intent signals → fitScore (1-100)
   └── Extract intentSignals[] (human-readable buying signal strings)
           │
4. Update each lead in GojiBerry:
   PATCH /v1/contact/{id} with { fitScore, intentSignals }
           │
5. Classify: warm (>= MIN_INTENT_SCORE) vs cold
           │
6. Output summary table + totals
```

## Key Design Decisions

### Scoring is LLM-delegated, not formula-based

Like lead discovery delegates ranking to the LLM prompt, enrichment delegates scoring to Claude. The prompt includes the ICP description, the lead's profile data, and the research findings. Claude returns a holistic score. This avoids brittle weighted formulas and lets the scoring understand nuance ("posted about outbound challenges" is a stronger signal for an outreach tool than "posted about hiring").

### Unenriched = no fitScore

The system identifies leads needing enrichment by checking `fitScore === null/undefined`. This is simple and works because feature 2 (discovery) does not set fitScore. The `forceRefresh` option overrides this filter for re-enrichment.

### Batch processing with FIFO ordering

Leads are enriched oldest-first (by createdAt) so the pipeline stays fair — leads from yesterday's discovery get enriched before today's. The batch size keeps each run predictable in terms of API calls and time.

### Intent signals are human-readable strings

Not enum codes or numeric weights. The founder reads these in the summary and in GojiBerry's UI. "Recently raised Series A" is more useful than `{ type: "funding", score: 0.8 }`. Claude generates them in plain English.

## Learnings

(To be populated after implementation via `/compound`)
