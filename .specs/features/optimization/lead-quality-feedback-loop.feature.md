---
feature: Lead Quality Feedback Loop
domain: optimization
source: src/automations/lead-quality-feedback-loop.ts
tests:
  - tests/automations/lead-quality-feedback-loop.test.ts
components: []
design_refs: []
status: implemented
created: 2026-04-13
updated: 2026-04-13
---

# Lead Quality Feedback Loop

**Source File**: src/automations/lead-quality-feedback-loop.ts
**Design System**: N/A (no UI — automation script)
**Depends on**: Campaign Performance Analytics (`src/automations/campaign-performance-analytics.ts`), Lead Enrichment + Intent Scoring (`src/automations/lead-enrichment.ts`), GojiBerry API Client (`src/api/gojiberry-client.ts`)

## Overview

Connects the full loop: discovery signals → enrichment quality → message effectiveness → campaign results. Identifies which intent types actually predict replies, which enrichment fields matter most, and produces scoring weight recommendations. This is the compounding intelligence layer — the system gets smarter with every campaign.

The founder doesn't think in terms of "enrichment fields" or "scoring weights." They want to know: "Which leads are worth my time?" This automation answers that by analyzing what actually worked, not what was predicted to work. The report speaks the founder's language: "Leads with 'recently raised funding' reply 3x more than leads flagged for 'job change' — prioritize funding signals."

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOJIBERRY_API_KEY` | Yes | Bearer token for GojiBerry API |
| `ANTHROPIC_API_KEY` | Yes | API key for Anthropic (used for pattern analysis across lead cohorts) |
| `MIN_CAMPAIGNS_FOR_FEEDBACK` | No | Minimum completed campaigns needed before generating feedback (default: 3) |
| `MIN_LEADS_FOR_FEEDBACK` | No | Minimum total leads with campaign outcomes before generating feedback (default: 30) |

## Feature: Lead Quality Feedback Loop

### Scenario: Generate full-loop quality feedback from campaign results
Given the founder has at least 3 completed campaigns
And at least 30 leads have been through the pipeline (discovered → enriched → messaged → campaigned)
When the lead quality feedback loop runs
Then it fetches all campaigns from GojiBerry via `GET /v1/campaign`
And fetches all leads with intent data via `GET /v1/contact`
And fetches intent type counts via `GET /v1/contact/intent-type-counts`
And correlates intent types with reply rates across campaigns
And identifies which enrichment signals predict replies vs. which are noise
And outputs a plain-English report the founder can scan in under 3 minutes

### Scenario: Identify intent types that predict replies
Given leads are tagged with intent types like "hiring", "funding", "job_change", "content_engagement"
And campaign data shows which leads replied
When the automation analyzes intent type → reply rate correlation
Then it computes reply rate per intent type: "funding: 22% reply rate (18 sent, 4 replied)"
And ranks intent types by reply rate (highest first)
And flags intent types with zero replies as "no signal"
And includes sample size for each so the founder can judge confidence

### Scenario: Identify enrichment signals that correlate with replies
Given leads have `intentSignals` arrays like ["Recently raised Series A", "Hiring 3 SDRs", "Posted about outbound challenges"]
And some of those leads replied and some didn't
When the automation analyzes signal → reply correlation
Then it extracts the most common signals across replied leads
And extracts the most common signals across non-replied leads
And computes signal effectiveness: "Leads with 'recently raised funding' signal: 25% reply rate vs. 8% overall"
And ranks signals by their lift over the baseline reply rate

### Scenario: Score field importance — which enrichment data matters
Given leads have varying data completeness (some have company, jobTitle, fitScore; others are sparse)
And campaign results show which leads replied
When the automation evaluates field importance
Then it compares reply rates for leads with vs. without each key field:
  - fitScore above median vs. below median
  - intentSignals present vs. empty
  - company field populated vs. missing
  - jobTitle field populated vs. missing
And identifies fields whose presence correlates with higher reply rates
And outputs: "Leads with intent signals reply at 18% vs. 3% for leads without — enrichment is worth the effort"

### Scenario: Detect scoring drift — fitScore no longer predicts replies
Given the enrichment automation assigns fitScore based on ICP match and intent
And historically high-score leads (fitScore >= 70) had better reply rates
When the automation compares recent campaigns to older ones
Then it checks if high-score leads still reply at higher rates than low-score leads
And if the correlation has weakened, flags it: "Scoring drift detected — high-score leads replied at 12% vs. 10% for low-score in recent campaigns. Scoring criteria may need recalibration."
And if correlation holds, confirms: "Scoring is still predictive — high-score leads reply at 3x the rate of low-score"

### Scenario: Recommend scoring weight adjustments
Given the analysis found that "funding" intent type predicts replies at 3x the overall rate
And "job_change" intent type predicts replies at only 1.1x the overall rate
When the automation generates recommendations
Then it suggests: "Weight 'funding' signals higher in enrichment scoring"
And suggests: "Deprioritize 'job_change' as a warm-lead indicator — it doesn't predict replies"
And marks each recommendation with confidence level based on sample size
And frames recommendations as suggestions — the founder decides what to change

### Scenario: Reject run when insufficient data
Given the founder has fewer than `MIN_CAMPAIGNS_FOR_FEEDBACK` completed campaigns (default: 3)
Or fewer than `MIN_LEADS_FOR_FEEDBACK` total leads with outcomes (default: 30)
When the lead quality feedback loop runs
Then it outputs: "Not enough data yet — need at least {min_campaigns} completed campaigns and {min_leads} leads with outcomes. You have {campaign_count} campaigns and {lead_count} leads."
And does not generate feedback
And returns a report with `recommendations: []`

### Scenario: Handle zero replies across all campaigns
Given the founder has 4 completed campaigns but zero leads replied
When the lead quality feedback loop runs
Then it outputs: "No replies yet across {count} campaigns — can't measure what predicts replies until some leads respond. Focus on improving messages first."
And does not generate scoring recommendations
And returns a report with a `noReplies: true` flag

### Scenario: Handle API authentication failure
Given the `GOJIBERRY_API_KEY` is invalid or expired
When the lead quality feedback loop runs
Then it throws an `AuthError` from the API client
And does not output a partial report

### Scenario: Handle missing Anthropic API key
Given `ANTHROPIC_API_KEY` is not set in `.env.local`
When the lead quality feedback loop runs
Then it throws a `ConfigError` with message: "Missing ANTHROPIC_API_KEY in .env.local — needed for pattern analysis"

### Scenario: Identify pipeline bottlenecks
Given leads flow through: discovery → enrichment → messaging → campaign
And data shows 100 leads discovered, 80 enriched, 60 messaged, 40 campaigned, 4 replied
When the automation maps the pipeline funnel
Then it outputs conversion rates at each stage:
  - Discovery → Enrichment: 80% (80/100)
  - Enrichment → Warm (above threshold): 75% (60/80)
  - Warm → Messaged: 100% (60/60)
  - Messaged → Campaigned: 67% (40/60)
  - Campaigned → Replied: 10% (4/40)
And identifies the biggest drop-off: "Biggest leak: messaged → campaigned (67%) — are leads getting stuck before campaign launch?"
And suggests where the founder should focus improvement effort

### Scenario: Compare early campaigns vs. recent campaigns
Given the founder has run 6+ campaigns over time
When the automation splits campaigns into first half and second half chronologically
Then it compares reply rates: "Early campaigns: 5% reply rate. Recent campaigns: 11% reply rate."
And identifies whether the pipeline is improving over time
And attributes improvement (or decline) to changes in: ICP targeting, enrichment quality, or message style
And outputs a trend summary: "Your pipeline is getting smarter — reply rate has doubled since you started"

### Scenario: Confidence thresholds for all recommendations
Given a recommendation is based on analyzing "funding" leads
And only 5 leads with "funding" intent type were contacted
When the automation evaluates confidence
Then it flags the recommendation as "low confidence — small sample (5 leads)"
And separates it from high-confidence recommendations (10+ leads)
And lists low-confidence items under "Signals to watch" rather than "Recommendations"

## Output Format

The report is a plain-text summary designed for the founder to scan quickly:

```
=== Lead Quality Feedback Report ===

Based on {campaign_count} campaigns, {total_leads} leads through the pipeline, {total_replied} replies ({overall_reply_rate}%)

--- Pipeline Funnel ---
  Discovered:  {count}
  Enriched:    {count} ({pct}% of discovered)
  Warm:        {count} ({pct}% of enriched)
  Campaigned:  {count} ({pct}% of warm)
  Replied:     {count} ({pct}% of campaigned)
  Biggest leak: {stage} ({pct}%)

--- Intent Types That Predict Replies ---
  {intent_type}: {reply_rate}% reply rate ({sent} sent, {replied} replied) — {confidence}
  {intent_type}: {reply_rate}% reply rate ({sent} sent, {replied} replied) — {confidence}
  No signal: {intent_types with 0 replies}

--- Enrichment Signals That Work ---
  "{signal}": {reply_rate}% reply rate vs. {baseline}% overall — {lift}x lift
  "{signal}": {reply_rate}% reply rate vs. {baseline}% overall — {lift}x lift

--- Enrichment Signals That Don't Work ---
  "{signal}": {reply_rate}% reply rate vs. {baseline}% overall — no lift

--- Scoring Health ---
  {scoring_status}: {explanation}

--- Trend ---
  Early campaigns ({count}): {reply_rate}% reply rate
  Recent campaigns ({count}): {reply_rate}% reply rate
  Trend: {improving|declining|stable}

--- Recommendations ---
  1. {recommendation} — {confidence} confidence
  2. {recommendation} — {confidence} confidence

--- Signals to Watch (low confidence) ---
  {signal}: {data} — need more data to confirm
```

## Function Signature

```typescript
export interface IntentTypeCorrelation {
  intentType: string;
  sent: number;
  replied: number;
  replyRate: number;
  confidence: 'high' | 'low';
}

export interface SignalEffectiveness {
  signal: string;
  leadsWithSignal: number;
  repliedWithSignal: number;
  replyRateWithSignal: number;
  baselineReplyRate: number;
  lift: number;                    // replyRateWithSignal / baselineReplyRate
  category: 'effective' | 'ineffective' | 'inconclusive';
  confidence: 'high' | 'low';
}

export interface PipelineFunnel {
  discovered: number;
  enriched: number;
  warm: number;
  campaigned: number;
  replied: number;
  biggestLeak: {
    stage: string;
    conversionRate: number;
  };
}

export interface ScoringHealth {
  status: 'predictive' | 'drifted' | 'insufficient_data';
  highScoreReplyRate: number;
  lowScoreReplyRate: number;
  explanation: string;
}

export interface FeedbackRecommendation {
  recommendation: string;
  type: 'weight_increase' | 'weight_decrease' | 'recalibrate' | 'focus_area';
  confidence: 'high' | 'low';
  dataPoint: string;               // The data backing the recommendation
}

export interface LeadQualityFeedbackReport {
  campaignCount: number;
  totalLeads: number;
  totalReplied: number;
  overallReplyRate: number;
  noReplies: boolean;
  funnel: PipelineFunnel;
  intentCorrelations: IntentTypeCorrelation[];
  signalEffectiveness: {
    effective: SignalEffectiveness[];
    ineffective: SignalEffectiveness[];
    inconclusive: SignalEffectiveness[];
  };
  scoringHealth: ScoringHealth;
  trend: {
    direction: 'improving' | 'declining' | 'stable' | 'insufficient_data';
    earlyReplyRate: number;
    recentReplyRate: number;
    earlyCampaignCount: number;
    recentCampaignCount: number;
  };
  recommendations: FeedbackRecommendation[];
  reportText: string;
}

type FeedbackClient = Pick<GojiBerryClient, 'getCampaigns' | 'searchLeads' | 'getIntentTypeCounts'>;

export type PatternAnalysisFn = (
  repliedLeads: Lead[],
  nonRepliedLeads: Lead[],
  allLeads: Lead[],
  campaigns: Campaign[],
) => Promise<{
  signalEffectiveness: SignalEffectiveness[];
  recommendations: FeedbackRecommendation[];
}>;

/** Real Anthropic-backed implementation of PatternAnalysisFn (exported for testing) */
export async function defaultAnalyzePatterns(
  repliedLeads: Lead[],
  nonRepliedLeads: Lead[],
  _allLeads: Lead[],
  _campaigns: Campaign[],
): Promise<{
  signalEffectiveness: SignalEffectiveness[];
  recommendations: FeedbackRecommendation[];
}>;

export async function analyzeLeadQuality(options?: {
  minCampaigns?: number;
  minLeads?: number;
  /** Injectable for testing — bypasses real Anthropic analysis */
  _analyzePatterns?: PatternAnalysisFn;
  /** Injectable for testing — bypasses real GojiBerry client */
  _client?: FeedbackClient;
}): Promise<LeadQualityFeedbackReport>;
```

## Data Flow

```
1. Validate config: GOJIBERRY_API_KEY and ANTHROPIC_API_KEY present
           │
2. Fetch campaigns first (sequential) via GET /v1/campaign
   └── AuthError propagates immediately — no partial report produced
           │
3. Fetch in parallel:
   ├── All leads via GET /v1/contact (paginated, all pages)
   └── Intent type counts via GET /v1/contact/intent-type-counts
           │
4. Gate check: minimum campaigns and minimum leads met?
   ├── No → return early with "not enough data" message
   └── Yes → continue
           │
5. Segment leads:
   ├── Replied leads (intentType: 'replied')
   └── Non-replied leads (all minus replied, via Set subtraction)
           │
6. Compute intent type correlations:
   ├── Group leads by intentType
   ├── For each type: count sent, count replied, compute reply rate
   └── Rank by reply rate, flag confidence by sample size
           │
7. Build pipeline funnel:
   ├── Count leads at each stage (discovered, enriched, warm, campaigned, replied)
   └── Identify biggest conversion drop-off
           │
8. Compute field importance (deterministic):
   ├── intentSignals present vs. empty
   ├── company populated vs. missing
   ├── jobTitle populated vs. missing
   └── fitScore above vs. below median
           │
9. Send to Claude for pattern analysis:
   ├── Replied lead profiles + intent signals
   └── Non-replied lead profiles + intent signals
           │
10. Claude extracts:
    ├── Signal effectiveness (which intentSignals[] items predict replies)
    └── Scoring weight recommendations
    └── Merge with field importance signals
           │
11. Compute scoring health:
    ├── Split leads by median fitScore
    ├── Compare reply rates above vs. below median
    └── Flag drift if ratio < 1.5x
           │
12. Compute trend:
    ├── Split campaigns chronologically (first half / second half)
    └── Compare reply rates (needs 6+ completed campaigns)
           │
13. Assemble report: funnel + intent correlations + signals + scoring + trend + recommendations
           │
14. Output report — founder reviews and decides what to change
```

## Dependencies

- `GojiBerryClient.getCampaigns()` — fetches all campaigns with metrics
- `GojiBerryClient.searchLeads()` — fetches lead profiles, paginated
- `GojiBerryClient.getIntentTypeCounts()` — intent type distribution
- `Campaign` and `Lead` types from `src/api/types.ts`
- Anthropic SDK — for pattern analysis across lead cohorts (LLM-delegated)

## Design Decisions

### LLM-delegated pattern analysis for signal effectiveness

Enrichment signals are free-text strings ("Recently raised Series A", "Posted about outbound challenges"). Matching and grouping these requires fuzzy string understanding — not exact match. Delegate to Claude via `PatternAnalysisFn`, same injectable pattern as `ProfileAnalysisFn` in ICP refinement and `WebResearchFn` in lead enrichment.

### Replied-lead segmentation reuses the `intentType: 'replied'` pattern

Same two-call pattern from ICP refinement: fetch `intentType: 'replied'` leads and all leads in parallel, subtract via Set. See ICP refinement learnings for details.

### Minimum data gates are higher than ICP refinement

ICP refinement needs 2 campaigns. This feature needs 3 campaigns and 30 leads because it's doing cross-cutting analysis (signal effectiveness, scoring health, trend) that needs more data to be meaningful. With 2 campaigns and 10 leads, every recommendation would be low-confidence noise.

### Pipeline funnel is approximate

There's no explicit "this lead was campaigned" flag in the API. Approximate by counting leads in campaigns vs. total leads. The funnel is directional ("where's the biggest leak?"), not precise accounting.

### Scoring health uses median split, not a fixed threshold

Splitting leads at the median fitScore (rather than a fixed 70) adapts to whatever scoring distribution the enrichment automation produces. If all scores cluster 40-60, a fixed 70 threshold would put nearly everyone in "low score" and make the comparison useless.

### Trend requires 6+ campaigns

Splitting campaigns into "first half" and "second half" with fewer than 6 gives 2-3 campaigns per group — too few for a meaningful comparison. Below 6, the trend section reports "insufficient data" rather than a potentially misleading direction.

## Learnings

(To be populated after implementation via /compound)
