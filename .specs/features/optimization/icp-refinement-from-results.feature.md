---
feature: ICP Refinement from Results
domain: optimization
source: src/automations/icp-refinement.ts
tests:
  - tests/automations/icp-refinement.test.ts
components: []
design_refs: []
status: implemented
created: 2026-04-13
updated: 2026-04-13
---

# ICP Refinement from Results

**Source File**: src/automations/icp-refinement.ts
**Design System**: N/A (no UI — automation script)
**Depends on**: Campaign Performance Analytics (`src/automations/campaign-performance-analytics.ts`), ICP-Based Lead Discovery (`src/automations/icp-lead-discovery.ts`), GojiBerry API Client (`src/api/gojiberry-client.ts`)

## Overview

Analyzes which leads actually reply and convert, compares their profiles against the current ICP description, and suggests refinements. The founder gets a plain-English report: "Your ICP says 'series A SaaS founders' but your best replies come from 'seed-stage fintech founders.' Consider updating."

This is the first piece of the optimization loop (Phase 4, Feature 30). The system gets smarter over time — each campaign's results feed back into who the founder targets next. The founder approves any changes to `ICP_DESCRIPTION` before they take effect. Nothing changes automatically.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOJIBERRY_API_KEY` | Yes | Bearer token for GojiBerry API |
| `ICP_DESCRIPTION` | Yes | Current plain-English ICP — the baseline being refined |
| `ANTHROPIC_API_KEY` | Yes | API key for Anthropic (used for profile analysis and refinement suggestions) |
| `MIN_CAMPAIGNS_FOR_REFINEMENT` | No | Minimum completed campaigns needed before suggesting refinements (default: 2) |

## Feature: ICP Refinement from Results

### Scenario: Generate ICP refinement suggestions from campaign results
Given the founder has at least 2 completed campaigns with reply data
And `ICP_DESCRIPTION` is set to "Series A SaaS founders in fintech who are actively hiring"
When the ICP refinement automation runs
Then it fetches all campaigns from GojiBerry via `GET /v1/campaign`
And fetches leads who replied (leads with `replied` status from campaign metrics)
And fetches leads who did not reply
And compares the profiles of replied leads against the current ICP
And identifies patterns in replied leads that differ from the ICP description
And outputs a refinement report with specific suggestions

### Scenario: Identify winning lead profile patterns
Given campaigns have produced replies from 15 leads
When the automation analyzes the replied leads
Then it extracts common patterns across replied leads:
  - Job titles that appear most often
  - Company stages or sizes that correlate with replies
  - Industries or verticals that convert
  - Buying signals that preceded replies
And ranks patterns by frequency and reply rate
And highlights patterns that diverge from the current ICP

### Scenario: Compare replied vs. non-replied lead profiles
Given 15 leads replied and 85 leads did not reply
When the automation runs the comparison
Then it identifies traits overrepresented in replied leads vs. non-replied
And identifies traits overrepresented in non-replied leads (signals to avoid)
And outputs a "what works" vs. "what doesn't" breakdown in the report

### Scenario: Suggest specific ICP description changes
Given the analysis found that seed-stage founders reply at 3x the rate of Series A founders
When the automation generates refinement suggestions
Then it outputs the current ICP description
And proposes a revised ICP description incorporating the winning patterns
And explains each suggested change with data: "Seed-stage founders: 22% reply rate vs. 7% for Series A"
And marks the suggestion as "proposed" — not applied

### Scenario: Founder approves ICP refinement
Given the automation output a proposed ICP refinement
When the founder reviews and says "yes, update it" or "apply this"
Then the automation is designed so the founder manually updates `ICP_DESCRIPTION` in `.env.local`
And the report reminds them: "Update ICP_DESCRIPTION in .env.local to apply this refinement"
And the next lead discovery run will use the updated ICP

### Scenario: Reject run when insufficient campaign data
Given the founder has fewer than `MIN_CAMPAIGNS_FOR_REFINEMENT` completed campaigns (default: 2)
When the ICP refinement automation runs
Then it outputs: "Not enough campaign data yet — need at least {min} completed campaigns with replies to suggest ICP refinements. You have {count}."
And does not generate refinement suggestions
And returns an empty report

### Scenario: Reject run when ICP description is missing
Given `ICP_DESCRIPTION` is not set in `.env.local`
When the ICP refinement automation runs
Then it throws a `ConfigError` with message: "Missing ICP_DESCRIPTION in .env.local — set your ideal customer description first"

### Scenario: Handle zero replies across all campaigns
Given the founder has 3 completed campaigns but zero leads replied
When the ICP refinement automation runs
Then it outputs: "No replies yet across {count} campaigns — can't refine what hasn't been validated. Focus on improving messages first (see /build-next for message style optimization)."
And does not suggest ICP changes
And returns a report with `suggestions: []`

### Scenario: Handle API authentication failure
Given the `GOJIBERRY_API_KEY` is invalid or expired
When the ICP refinement automation runs
Then it throws an `AuthError` from the API client
And does not output a partial report

### Scenario: Identify ICP traits that predict non-response
Given campaign data shows that leads with "VP of Engineering" title never reply
And leads from companies with 500+ employees have a 1% reply rate
When the automation runs
Then it includes a "signals to deprioritize" section in the report
And lists traits that correlate with low or zero reply rates
And suggests narrowing the ICP to exclude these segments

### Scenario: Preserve what's already working in the ICP
Given the current ICP includes "fintech" and fintech leads reply at 18%
And the current ICP includes "actively hiring" and that signal has no correlation with replies
When the automation generates suggestions
Then it affirms traits that correlate with replies: "Keep: fintech vertical (18% reply rate)"
And flags traits with no signal: "Inconclusive: 'actively hiring' — no measurable impact on reply rate"
And only suggests removing or changing traits that actively hurt performance

### Scenario: Confidence threshold for suggestions
Given the automation found that "AI/ML" leads reply at 25% vs. 10% overall
But only 4 leads in the "AI/ML" segment were contacted
When evaluating whether to suggest adding "AI/ML" to the ICP
Then it flags the suggestion as "low confidence — small sample size (4 leads)"
And does not include it as a primary recommendation
And lists it under "signals to watch" for future validation

## Output Format

The report is a plain-text summary designed for the founder to scan in under 2 minutes:

```
=== ICP Refinement Report ===

Current ICP: "{current_icp_description}"

Based on {total_campaigns} campaigns, {total_replied} replies out of {total_sent} sent ({overall_reply_rate}%)

--- What's Working (keep these) ---
  {trait}: {reply_rate}% reply rate ({count} replies)
  {trait}: {reply_rate}% reply rate ({count} replies)

--- What's Not Working (consider dropping) ---
  {trait}: {reply_rate}% reply rate ({count} sent, {replied} replies)
  {trait}: {reply_rate}% reply rate ({count} sent, {replied} replies)

--- Inconclusive (not enough data) ---
  {trait}: {reply_rate}% reply rate — only {count} leads contacted

--- Signals to Watch ---
  {trait}: promising at {reply_rate}% but small sample ({count} leads)

--- Suggested ICP Update ---

Current:  "{current_icp_description}"
Proposed: "{proposed_icp_description}"

Changes:
  + Added: {trait} — {reason with data}
  - Removed: {trait} — {reason with data}
  ~ Modified: {trait} → {new_trait} — {reason with data}

To apply: update ICP_DESCRIPTION in .env.local
```

## Function Signature

```typescript
export interface IcpTrait {
  trait: string;
  replyRate: number;
  sampleSize: number;
  replied: number;
  category: 'working' | 'not_working' | 'inconclusive' | 'watch';
  confidence: 'high' | 'low';
}

export interface IcpRefinementSuggestion {
  type: 'add' | 'remove' | 'modify';
  trait: string;
  newTrait?: string;       // Only for 'modify' type
  reason: string;          // Data-backed explanation
  confidence: 'high' | 'low';
}

export interface IcpRefinementReport {
  currentIcp: string;
  campaignCount: number;
  totalSent: number;
  totalReplied: number;
  overallReplyRate: number;
  traits: {
    working: IcpTrait[];
    notWorking: IcpTrait[];
    inconclusive: IcpTrait[];
    watch: IcpTrait[];
  };
  suggestions: IcpRefinementSuggestion[];
  proposedIcp: string | null;       // null when no changes suggested
  reportText: string;
}

type RefinementClient = Pick<GojiBerryClient, 'getCampaigns' | 'searchLeads'>;

export type ProfileAnalysisFn = (
  currentIcp: string,
  repliedLeads: ContactSummary[],
  nonRepliedLeads: ContactSummary[],
) => Promise<{
  traits: IcpTrait[];
  suggestions: IcpRefinementSuggestion[];
  proposedIcp: string;
}>;

export async function refineIcp(options?: {
  icpDescription?: string;
  minCampaigns?: number;
  /** Injectable for testing — bypasses real Anthropic analysis */
  _analyzeProfiles?: ProfileAnalysisFn;
  /** Injectable for testing — bypasses real GojiBerry client */
  _client?: RefinementClient;
}): Promise<IcpRefinementReport>;
```

## Data Flow

```
1. Read ICP_DESCRIPTION from .env.local
           │
2. Fetch all campaigns via GET /v1/campaign
           │
3. Filter to completed campaigns (all completed, regardless of reply count)
           │
4. Check minimum campaign threshold
           │
5. Fetch leads from replied campaigns:
   ├── Replied leads (from campaign metrics)
   └── Non-replied leads (same campaigns, no reply)
           │
6. Send to Claude for profile analysis:
   ├── Current ICP description
   ├── Replied lead profiles
   └── Non-replied lead profiles
           │
7. Claude extracts trait patterns and compares to ICP
           │
8. Generate refinement suggestions with data backing
           │
9. Build report text with proposed ICP update
           │
10. Output report — founder reviews and decides
```

## Dependencies

- `GojiBerryClient.getCampaigns()` — fetches all campaigns with metrics
- `GojiBerryClient.searchLeads()` — fetches lead profiles for replied/non-replied segmentation
- `Campaign` type from `src/api/types.ts`
- Anthropic SDK — for profile pattern analysis (LLM-delegated, not rule-based)

## Design Decisions

### LLM-delegated profile analysis (not rule-based)

Pattern extraction across lead profiles is inherently fuzzy — job title normalization, company stage inference, industry classification. Delegate this to Claude via a typed `ProfileAnalysisFn` rather than building a rule engine. Same pattern as `WebSearchFn` in lead discovery: inject for testing, use real Anthropic call in production.

### Approval gate is manual `.env.local` edit

The founder updates `ICP_DESCRIPTION` themselves. The automation never writes to `.env.local`. This is the simplest approval gate and matches the project's "human approves, system proposes" principle.

### Confidence thresholds based on sample size

Suggestions from segments with fewer than 10 leads are flagged as "low confidence." This prevents the founder from over-rotating on small samples. The threshold is a named constant (`MIN_SAMPLE_FOR_HIGH_CONFIDENCE`) in the implementation, not an env var — it's a statistical judgment, not a user preference.

### Minimum campaigns gate prevents premature optimization

With 1 campaign, any pattern could be noise. Default minimum of 2 completed campaigns ensures at least some basis for comparison. Configurable via `MIN_CAMPAIGNS_FOR_REFINEMENT` for founders running many small campaigns.

## Learnings

### `intentType: 'replied'` as reply-status proxy — not a literal API field

The spec described "fetches leads who replied" as if there's a per-lead reply-status filter. There isn't. The GojiBerry API exposes `intentType` as a string filter on `searchLeads`. Using `intentType: 'replied'` is the pragmatic workaround. Non-replied leads are derived: fetch all leads, subtract replied IDs via a Set.

The two-call pattern runs in parallel:
```ts
const [repliedResult, allLeadsResult] = await Promise.all([
  client.searchLeads({ intentType: 'replied' }),
  client.searchLeads(),
]);
const repliedIds = new Set(repliedResult.leads.map((l) => l.id));
const nonReplied = allLeadsResult.leads.filter((l) => !repliedIds.has(l.id));
```

### `proposedIcp: null` when no high-confidence suggestions exist

Gate the `proposedIcp` field to `null` when the LLM returns only low-confidence suggestions. This prevents the founder from acting on noise. Test scenario: all traits have `sampleSize < 10` → `proposedIcp === null`. Without this gate, a small sample could produce a "proposed" ICP that looks authoritative but isn't.

### Dependency section drifted — `analyzeCampaignPerformance` was never used

The spec's Dependencies section listed `analyzeCampaignPerformance()` from `campaign-performance-analytics.ts` as a dependency. The implementation never imported it — metrics were computed directly from `c.metrics` on the campaign response, which was simpler and didn't need the analytics layer. The drift check caught this and removed the false dependency. Root cause: spec written before implementation anticipated reuse of an existing helper; the simpler path made it unnecessary. Verify the Dependencies section during every drift check — it's as prone to pre-implementation optimism as the Data Flow section.
