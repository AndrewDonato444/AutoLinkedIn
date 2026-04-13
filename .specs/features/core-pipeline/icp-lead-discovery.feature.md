---
feature: ICP-Based Lead Discovery
domain: core-pipeline
source: src/automations/icp-lead-discovery.ts
tests:
  - tests/automations/icp-lead-discovery.test.ts
components: []
design_refs: []
status: stub
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

### Scenario: Skip duplicate leads already in GojiBerry
Given the automation discovered a lead with profileUrl "linkedin.com/in/jane-doe"
And a lead with that profileUrl already exists in GojiBerry
When the automation attempts to create the lead
Then it skips the duplicate
And logs: "Skipped: Jane Doe — already in GojiBerry"
And the duplicate is not counted toward the scan limit

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
When it ranks them by ICP relevance
Then it selects the top 10 closest matches to the ICP description
And creates those 10 in GojiBerry
And the skipped leads are the weakest matches

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
4. Rank by ICP fit, apply DAILY_LEAD_SCAN_LIMIT
           │
5. For each lead:
   ├── Check if profileUrl exists in GojiBerry (searchLeads)
   ├── If exists → skip (add to skipped[])
   └── If new → createLead() via GojiBerry API client
           │
6. Output summary table + totals
```

## Learnings

