---
feature: ICP-Based Lead Discovery
domain: core-pipeline
source: src/automations/icp-lead-discovery.ts
tests:
  - tests/automations/icp-lead-discovery.test.ts
components: []
design_refs: []
status: implemented
created: 2026-04-13
updated: 2026-04-13
---

# ICP-Based Lead Discovery

**Source File**: src/automations/icp-lead-discovery.ts
**Design System**: N/A (no UI — automation script)
**Depends on**: GojiBerry API Client (`src/api/gojiberry-client.ts`)

## Overview

Claude automation that reads `ICP_DESCRIPTION` from `.env.local`, searches the web for matching leads, and creates them in GojiBerry via `POST /v1/contact`. This is the first step of the core pipeline — turning an ICP description into real leads sitting in GojiBerry, ready for enrichment and outreach.

The founder describes their ideal customer in plain English. The system finds people who match, creates them as leads in GojiBerry, and outputs a summary. No messages are sent — this is discovery only.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ICP_DESCRIPTION` | Yes | Plain-English description of ideal customer (e.g., "Series A SaaS founders in fintech who are actively hiring") |
| `DAILY_LEAD_SCAN_LIMIT` | No | Max leads to discover per run (default: 50) |
| `GOJIBERRY_API_KEY` | Yes | Bearer token for GojiBerry API (used by API client) |
| `ANTHROPIC_API_KEY` | Yes | API key for Anthropic (used by `defaultWebSearch` to call Claude with web search tool) |

## Feature: ICP-Based Lead Discovery

### Scenario: Discover leads from ICP description
Given the founder has set `ICP_DESCRIPTION` to "Series A SaaS founders in fintech who are actively hiring"
And the GojiBerry API client is authenticated
When the lead discovery automation runs
Then it searches the web for people matching the ICP
And creates each discovered lead in GojiBerry via `POST /v1/contact`
And outputs a summary: "{count} leads found and added to GojiBerry"

### Scenario: Reject run when ICP description is missing
Given `ICP_DESCRIPTION` is empty or not set in `.env.local`
When the lead discovery automation runs
Then it throws a `ConfigError` with message: "Missing ICP_DESCRIPTION in .env.local — describe your ideal customer first"
And no web searches are performed
And no leads are created

### Scenario: Respect daily lead scan limit
Given `ICP_DESCRIPTION` is set
And `DAILY_LEAD_SCAN_LIMIT` is set to 10
When the automation discovers 25 potential leads from web search
Then it creates only the top 10 leads in GojiBerry (ranked by ICP fit)
And outputs: "10 leads added (limit: 10, 15 additional matches skipped)"

### Scenario: Use default limit when DAILY_LEAD_SCAN_LIMIT is not set
Given `ICP_DESCRIPTION` is set
And `DAILY_LEAD_SCAN_LIMIT` is not set in `.env.local`
When the lead discovery automation runs
Then it uses a default limit of 50 leads

### Scenario: Skip duplicate leads already in the master contact store
Given the master contact store (`data/contacts.jsonl`) contains a contact with profileUrl "linkedin.com/in/jane-doe"
And the automation discovers a lead with that same profileUrl
When the automation processes the lead
Then it skips the duplicate without calling the GojiBerry API
And logs: "Skipped: Jane Doe — already in GojiBerry"
And the duplicate slot is consumed from the scan limit (duplicates are detected during processing, after the limit window is applied)

**Implementation note**: Dedup reads from the master contact store, not from the GojiBerry `searchLeads` API. Master is the source of truth. Callers (e.g. `daily-lead-scan.ts`) should call `rebuildMaster()` before `discoverLeads()` to ensure dedup reflects the latest GojiBerry state.

### Scenario: Dedup tolerates LinkedIn URL variations
Given the master contains "https://www.linkedin.com/in/jane-doe/"
And the automation discovers "http://linkedin.com/in/jane-doe" (or any variation — https↔http, www↔no-www, trailing slash, query string, fragment)
When the automation processes the lead
Then it treats them as the same contact and skips the duplicate
Because URLs are normalized via `normalizeLinkedInUrl` (from `src/utils/linkedin-url.ts`) before comparison

### Scenario: Dedup prevents duplicates within a single scan
Given the web search returns two results pointing at the same LinkedIn profile (same URL, possibly different formats)
When the automation processes both
Then only the first is created in GojiBerry
And the second is added to `skipped[]`
Because the in-memory seen-set is updated after each successful create

### Scenario: Extract structured lead data from web search
Given the automation found a matching person on the web
When it creates the lead in GojiBerry
Then the lead includes at minimum: firstName, lastName, profileUrl
And includes when available: company, jobTitle, location
And the profileUrl is a LinkedIn profile URL when possible

### Scenario: Handle web search returning no results
Given `ICP_DESCRIPTION` is set to a very narrow criteria
When the web search returns no matching leads
Then the automation outputs: "No leads found matching your ICP — try broadening your ideal customer description"
And no leads are created in GojiBerry

### Scenario: Handle GojiBerry API errors during lead creation
Given the automation discovered 10 matching leads
And the GojiBerry API returns an error when creating lead #4
When the automation processes the batch
Then it logs the error: "Failed to create lead: {firstName} {lastName} — {error message}"
And continues creating the remaining leads
And the summary includes: "7 leads added, 1 failed (see logs)"

### Scenario: Handle rate limits during batch creation
Given the automation discovered 60 matching leads within the scan limit
When creating leads would exceed the 100 req/min rate limit
Then the GojiBerry API client handles rate limiting automatically
And all leads are created without rate limit errors

### Scenario: Output lead summary after discovery
Given the automation successfully created 12 leads
When the run completes
Then it outputs a summary table with each lead's name, company, title, and profileUrl
And a total line: "12 leads found and added to GojiBerry — ready for enrichment"

### Scenario: Handle authentication failure
Given the GojiBerry API key is invalid or expired
When the lead discovery automation runs
Then it throws an `AuthError` from the API client
And outputs: "GojiBerry API key is invalid or expired — check GOJIBERRY_API_KEY in .env.local"
And no leads are created

### Scenario: Rank leads by ICP fit before applying limit
Given `DAILY_LEAD_SCAN_LIMIT` is 10
And the automation discovered 20 potential leads
When the web search returns leads ranked best-to-weakest ICP fit (ranking delegated to Anthropic web search prompt)
Then the automation selects the top 10 (first in the ranked list)
And creates those 10 in GojiBerry
And the leads beyond position 10 (weakest matches) are not created

## Module Structure

```
src/automations/
├── icp-lead-discovery.ts   # Main automation — orchestrates search + create
└── types.ts                # Discovery-specific types (DiscoveredLead, DiscoveryResult, etc.)
```

## Public API Surface

```typescript
interface DiscoveredLead {
  firstName: string;
  lastName: string;
  profileUrl: string;
  company?: string;
  jobTitle?: string;
  location?: string;
  icpFitReason?: string;   // Why this person matches the ICP
}

interface DiscoveryResult {
  created: DiscoveredLead[];    // Leads successfully added to GojiBerry
  skipped: DiscoveredLead[];    // Duplicates already in GojiBerry
  failed: { lead: DiscoveredLead; error: string }[];  // Creation failures
  limitExceeded: number;        // Count of matches beyond scan limit
}

async function discoverLeads(options?: {
  icpDescription?: string;  // Override .env.local ICP_DESCRIPTION
  limit?: number;           // Override DAILY_LEAD_SCAN_LIMIT
  _webSearch?: WebSearchFn; // Test-only: inject a mock web search function
  _client?: LeadClient;     // Test-only: inject a mock GojiBerry client
}): Promise<DiscoveryResult>
```

## Data Flow

```
1. Read ICP_DESCRIPTION from .env.local
           │
2. Search web for matching people (Claude web search)
           │
3. Parse results → DiscoveredLead[]
           │
4. Apply DAILY_LEAD_SCAN_LIMIT (leads already ranked best-first by web search)
           │
5. Load master contact store → build Set<normalizedUrl>
           │
6. For each lead:
   ├── Normalize profileUrl via `normalizeLinkedInUrl`
   ├── If in Set → skip (add to skipped[])
   └── If new → createLead() via GojiBerry API client, then add to Set
           │
6. Output summary table + totals
```

## Learnings

### `_`-prefixed options injection for SDK testability

Instead of mocking the Anthropic SDK (constructor + method chain), inject a typed function:

```ts
type WebSearchFn = (icpDescription: string) => Promise<DiscoveredLead[]>;

async function discoverLeads(options?: {
  _webSearch?: WebSearchFn;  // test-only
  _client?: LeadClient;       // test-only
})
```

Tests pass a simple `vi.fn()` returning `DiscoveredLead[]`. No SDK setup needed. The `_` prefix signals "internal/testing contract" to callers. The real implementation lives in `defaultWebSearch`, which tests never touch.

### `Number("")` returns 0, not NaN — guard env var number parsing

```ts
// WRONG — DAILY_LEAD_SCAN_LIMIT="" → Number("") = 0, not DEFAULT_LIMIT
const limit = Number(process.env.DAILY_LEAD_SCAN_LIMIT) || DEFAULT_LIMIT;

// RIGHT — coerce falsy (empty string) before Number()
const rawLimit = options.limit ?? Number(process.env.DAILY_LEAD_SCAN_LIMIT || DEFAULT_LIMIT);
const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
```

Empty string is a real env var state (set but blank). `Number("")` silently returns 0.

### `as any` for unreleased Anthropic SDK tool types

`web_search_20250305` is not yet in the SDK's type definitions. Cast `tools` as `any` with an inline comment explaining why:

```ts
tools: [{ type: 'web_search_20250305', name: 'web_search' }] as any,
// web_search_20250305 is not in the SDK types yet — cast required
```

Remove the cast once the tool is added to the SDK.

### Duplicates consume scan limit slots (by design)

The `slice(0, limit)` is applied **before** the processing loop, so duplicates count against the limit. A spec that says "skip duplicates, don't count toward limit" requires a two-pass approach: first filter duplicates, then apply limit to the non-duplicate set. The current single-pass approach is simpler but means 10 slots may only create 8 leads if 2 are duplicates. Document this tradeoff in any spec that cares about exact creation counts.

### Delegate ranking to the LLM prompt, not code

Rather than implementing a scoring/ranking function, instruct the model to return results "ranked from best ICP fit to weakest" and `slice(0, limit)` the array. This is simpler and produces better results since the LLM understands the ICP semantically. The spec should say "ranked by the web search" not "ranked by the automation."

