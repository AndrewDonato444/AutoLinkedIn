---
feature: Message Style Optimization
domain: optimization
source: src/automations/message-style-optimization.ts
tests:
  - tests/automations/message-style-optimization.test.ts
components: []
design_refs: []
status: specced
created: 2026-04-13
updated: 2026-04-13
---

# Message Style Optimization

**Source File**: src/automations/message-style-optimization.ts
**Design System**: N/A (no UI — automation script)
**Depends on**: Campaign Performance Analytics (`src/automations/campaign-performance-analytics.ts`), Personalized Message Generation (`src/automations/message-generation.ts`), GojiBerry API Client (`src/api/gojiberry-client.ts`)

## Overview

Compares message patterns across campaigns to identify what hooks, lengths, and personalization elements drive replies. The founder gets a plain-English report: "Question openers get 2.4x more replies than compliment openers. Messages under 200 characters outperform longer ones. Leads respond best when you reference their recent hiring activity."

This is Feature 31 in the roadmap (Phase 4: Optimization Loop). The founder doesn't want to A/B test manually — the system analyzes what already worked and updates the message generation approach. Each round of outreach gets smarter because the system learns which message styles actually get replies.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOJIBERRY_API_KEY` | Yes | Bearer token for GojiBerry API |
| `ANTHROPIC_API_KEY` | Yes | API key for Anthropic (used for message pattern analysis) |
| `MIN_CAMPAIGNS_FOR_STYLE_ANALYSIS` | No | Minimum completed campaigns with replies before analyzing (default: 2) |
| `MIN_MESSAGES_FOR_ANALYSIS` | No | Minimum total messaged leads before analyzing (default: 10) |

## Feature: Message Style Optimization

### Scenario: Generate message style analysis from campaign results
Given the founder has at least 2 completed campaigns with reply data
And at least 10 leads have personalizedMessages stored in GojiBerry
When the message style optimization automation runs
Then it fetches all campaigns from GojiBerry via `GET /v1/campaign`
And fetches leads who replied (via `intentType: 'replied'`)
And fetches leads who were messaged but did not reply
And compares the personalizedMessages of replied leads vs. non-replied leads
And identifies patterns in hook style, message length, and personalization elements
And outputs a style optimization report with specific recommendations

### Scenario: Identify winning hook styles
Given replied leads have a mix of message openers: question hooks, compliment hooks, direct ask hooks, and mutual-connection hooks
When the automation analyzes message patterns
Then it categorizes each message by its opening hook style
And computes reply rate per hook style
And ranks hook styles by effectiveness
And outputs: "Question openers: {reply_rate}% reply rate ({count} sent) — best performing"
And highlights the gap between best and worst hook styles

### Scenario: Analyze optimal message length
Given leads have personalizedMessages of varying character lengths
When the automation compares replied vs. non-replied messages
Then it computes average message length for replied leads vs. non-replied leads
And buckets messages into length ranges (under 150 chars, 150-250 chars, 250+ chars)
And computes reply rate per length bucket
And outputs the optimal length range: "Messages in the {range} range get the best reply rate ({rate}%)"

### Scenario: Identify which personalization elements drive replies
Given messages reference different types of buying signals (hiring, fundraising, product launches, content activity, job changes)
When the automation analyzes which signal types appear in replied messages vs. non-replied
Then it identifies signal types that are overrepresented in replied messages
And identifies signal types that appear in messages but don't correlate with replies
And outputs: "Referencing hiring signals drives replies ({rate}%). Product launch mentions don't move the needle ({rate}%)."

### Scenario: Detect template-sounding messages that underperform
Given some generated messages contain phrases that sound generic despite using real signals
When the automation scans non-replied messages for common weak patterns
Then it identifies overused phrases that correlate with non-reply (e.g., "I'd love to connect", "reaching out because")
And suggests replacements or avoidance rules
And outputs: "Messages containing '{phrase}' have a {rate}% reply rate — consider avoiding"

### Scenario: Generate updated message generation guidance
Given the analysis identified winning patterns and losing patterns
When the automation produces its final recommendations
Then it outputs a structured guidance block that can inform future message generation:
  - Preferred hook style with example
  - Optimal character length range
  - Signal types to prioritize referencing
  - Phrases to avoid
And marks this as "proposed" — the founder reviews before applying

### Scenario: Reject run when insufficient campaign data
Given the founder has fewer than `MIN_CAMPAIGNS_FOR_STYLE_ANALYSIS` completed campaigns (default: 2)
When the message style optimization automation runs
Then it outputs: "Not enough campaign data yet — need at least {min} completed campaigns with replies to analyze message styles. You have {count}."
And does not generate style analysis
And returns an empty report

### Scenario: Reject run when insufficient messaged leads
Given the founder has enough campaigns but fewer than `MIN_MESSAGES_FOR_ANALYSIS` leads with personalizedMessages (default: 10)
When the message style optimization automation runs
Then it outputs: "Not enough messaged leads yet — need at least {min} leads with messages to analyze patterns. You have {count}."
And does not generate style analysis
And returns an empty report

### Scenario: Handle zero replies across all campaigns
Given campaigns have sent messages but zero leads replied
When the message style optimization runs
Then it outputs: "No replies yet — can't optimize what hasn't been validated. Focus on ICP refinement first to ensure you're reaching the right people."
And does not suggest style changes
And returns a report with `recommendations: []`

### Scenario: Handle API authentication failure
Given the `GOJIBERRY_API_KEY` is invalid or expired
When the message style optimization automation runs
Then it throws an `AuthError` from the API client
And does not output a partial report

### Scenario: Confidence threshold for recommendations
Given the analysis found that "direct ask" openers have a 30% reply rate
But only 3 messages used that hook style
When evaluating whether to recommend "direct ask" openers
Then it flags the recommendation as "low confidence — small sample size (3 messages)"
And does not include it as a primary recommendation
And lists it under "patterns to watch" for future validation

### Scenario: Compare current tone setting against what actually works
Given `MESSAGE_TONE` is set to "professional"
But casual-sounding messages in the data have a higher reply rate
When the automation runs
Then it includes a tone recommendation: "Your current tone is 'professional' but casual messages reply at {casual_rate}% vs. {professional_rate}%. Consider switching MESSAGE_TONE to 'casual'."
And marks this as a suggestion — founder decides

### Scenario: Output summary with actionable next steps
Given the analysis is complete with recommendations
When the automation outputs the final report
Then the report ends with a "Next Steps" section listing concrete actions:
  - Which env vars to update (e.g., MESSAGE_TONE, MESSAGE_MAX_LENGTH)
  - Whether to regenerate messages for un-replied leads with updated style
And reminds the founder: "Run message generation with forceRegenerate to apply new style to existing leads"

## Output Format

The report is a plain-text summary the founder can scan in under 2 minutes:

```
=== Message Style Optimization Report ===

Based on {total_campaigns} campaigns, {total_messaged} leads messaged, {total_replied} replies ({overall_reply_rate}%)

--- Hook Style Analysis ---
  Best:  {hook_style} — {reply_rate}% reply rate ({count} messages)
  Worst: {hook_style} — {reply_rate}% reply rate ({count} messages)

  Breakdown:
    Question openers:    {rate}% ({count} sent, {replied} replies)
    Compliment openers:  {rate}% ({count} sent, {replied} replies)
    Direct ask openers:  {rate}% ({count} sent, {replied} replies)
    Mutual connection:   {rate}% ({count} sent, {replied} replies)

--- Message Length Analysis ---
  Optimal range: {range} characters
  
  Under 150 chars:  {rate}% reply rate ({count} messages)
  150-250 chars:    {rate}% reply rate ({count} messages)
  250+ chars:       {rate}% reply rate ({count} messages)
  
  Avg length (replied): {avg_replied} chars
  Avg length (no reply): {avg_no_reply} chars

--- Signal Effectiveness ---
  Drives replies:
    {signal_type}: {rate}% reply rate when referenced
    {signal_type}: {rate}% reply rate when referenced
  
  No impact:
    {signal_type}: {rate}% reply rate — same as baseline

--- Phrases to Avoid ---
  "{phrase}": {rate}% reply rate in messages containing it
  "{phrase}": {rate}% reply rate in messages containing it

--- Patterns to Watch (low confidence) ---
  {pattern}: promising at {rate}% but only {count} messages — needs more data

--- Recommendations ---
  1. {recommendation with data backing}
  2. {recommendation with data backing}
  3. {recommendation with data backing}

--- Next Steps ---
  - Update MESSAGE_TONE to "{suggested_tone}" in .env.local
  - Update MESSAGE_MAX_LENGTH to {suggested_length} in .env.local
  - Run message generation with forceRegenerate to apply new style
```

## Function Signature

```typescript
export interface HookStyleAnalysis {
  style: string;            // e.g., "question", "compliment", "direct_ask", "mutual_connection"
  count: number;            // Messages using this hook
  replied: number;          // How many got replies
  replyRate: number;
  confidence: 'high' | 'low';
}

export interface LengthBucket {
  range: string;            // e.g., "under_150", "150_250", "250_plus"
  label: string;            // e.g., "Under 150 chars"
  count: number;
  replied: number;
  replyRate: number;
}

export interface SignalEffectiveness {
  signalType: string;       // e.g., "hiring", "fundraising", "content_activity"
  count: number;            // Messages referencing this signal type
  replied: number;
  replyRate: number;
  impact: 'drives_replies' | 'no_impact' | 'hurts';
  confidence: 'high' | 'low';
}

export interface PhraseAnalysis {
  phrase: string;
  count: number;
  replied: number;
  replyRate: number;
}

export interface StyleRecommendation {
  type: 'hook_style' | 'message_length' | 'signal_priority' | 'tone' | 'phrase_avoid';
  recommendation: string;    // Human-readable recommendation
  data: string;              // Data backing the recommendation
  confidence: 'high' | 'low';
  envVar?: string;           // Which env var to update, if applicable
  suggestedValue?: string;   // Suggested new value
}

export interface MessageStyleReport {
  campaignCount: number;
  totalMessaged: number;
  totalReplied: number;
  overallReplyRate: number;
  hookStyles: HookStyleAnalysis[];
  lengthBuckets: LengthBucket[];
  avgLengthReplied: number;
  avgLengthNoReply: number;
  signalEffectiveness: SignalEffectiveness[];
  phrasesToAvoid: PhraseAnalysis[];
  patternsToWatch: (HookStyleAnalysis | SignalEffectiveness)[];
  recommendations: StyleRecommendation[];
  reportText: string;
}

export type MessagePatternAnalysisFn = (
  repliedMessages: { lead: Lead; message: string }[],
  nonRepliedMessages: { lead: Lead; message: string }[],
  currentTone: string,
) => Promise<{
  hookStyles: HookStyleAnalysis[];
  lengthBuckets: LengthBucket[];
  avgLengthReplied: number;
  avgLengthNoReply: number;
  signalEffectiveness: SignalEffectiveness[];
  phrasesToAvoid: PhraseAnalysis[];
  patternsToWatch: (HookStyleAnalysis | SignalEffectiveness)[];
  recommendations: StyleRecommendation[];
}>;

type StyleOptClient = Pick<GojiBerryClient, 'getCampaigns' | 'searchLeads'>;

export interface MessageStyleOptions {
  minCampaigns?: number;
  minMessages?: number;
  currentTone?: string;
  /** Injectable for testing — bypasses real Anthropic analysis */
  _analyzePatterns?: MessagePatternAnalysisFn;
  /** Injectable for testing — bypasses real GojiBerry client */
  _client?: StyleOptClient;
}

export async function optimizeMessageStyle(
  options?: MessageStyleOptions,
): Promise<MessageStyleReport>;
```

## Data Flow

```
1. Read MESSAGE_TONE from .env.local (or option override)
           │
2. Fetch all campaigns via GET /v1/campaign
           │
3. Filter to completed campaigns with sends
           │
4. Check minimum campaign threshold
           │
5. Fetch replied leads and non-replied leads in parallel:
   ├── Replied: searchLeads({ intentType: 'replied' })
   └── All messaged: searchLeads() → filter to those with personalizedMessages
   └── Non-replied: all messaged minus replied (via Set of IDs)
           │
6. Check minimum messaged leads threshold
           │
7. Check for zero replies
           │
8. Extract message text from each lead's personalizedMessages[0]
           │
9. Send to Claude for pattern analysis:
   ├── Replied messages with lead context
   ├── Non-replied messages with lead context
   └── Current tone setting
           │
10. Claude classifies hook styles, analyzes lengths,
    maps signal references, detects weak phrases
           │
11. Compute confidence levels based on sample sizes
           │
12. Generate recommendations with data backing
           │
13. Build report text with next steps
           │
14. Output report — founder reviews and decides what to apply
```

## Dependencies

- `GojiBerryClient.getCampaigns()` — fetches all campaigns with metrics
- `GojiBerryClient.searchLeads()` — fetches lead profiles with personalizedMessages
- `Campaign` type from `src/api/types.ts`
- `Lead` type from `src/api/types.ts` — needs `personalizedMessages` field
- Anthropic SDK — for message pattern analysis (LLM-delegated, not rule-based)

## Design Decisions

### LLM-delegated pattern analysis (not regex-based)

Classifying hook styles ("is this a question opener or a compliment opener?") and detecting weak phrases are inherently fuzzy text-analysis tasks. Delegate to Claude via a typed `MessagePatternAnalysisFn` rather than building regex classifiers. Same injectable pattern as `ProfileAnalysisFn` in ICP refinement and `WebResearchFn` in lead discovery.

### Reply status via `intentType: 'replied'` filter

Same approach as ICP refinement: `searchLeads({ intentType: 'replied' })` fetches leads who replied. Non-replied leads are derived by subtracting replied IDs from all messaged leads. This is a pragmatic workaround — there's no per-lead reply-status filter in the GojiBerry API.

### personalizedMessages[0] is the message to analyze

Each lead's `personalizedMessages` is a `string[]`. We analyze the first element — that's the message that was actually sent (or would be sent). Future versions could analyze multiple variants if A/B testing is implemented.

### Confidence threshold matches ICP refinement

Recommendations from segments with fewer than 10 messages are flagged as "low confidence" and moved to "patterns to watch." Consistent with the `MIN_SAMPLE_FOR_HIGH_CONFIDENCE` approach in ICP refinement. Prevents the founder from over-rotating on small samples.

### Guidance is advisory, not auto-applied

The automation never writes to `.env.local` or modifies `MESSAGE_TONE` / `MESSAGE_MAX_LENGTH`. It proposes changes; the founder applies them. This matches the project's "human approves, system proposes" principle. The "Next Steps" section tells the founder exactly what to change.

### No dependency on `analyzeCampaignPerformance()`

Per the learning from ICP refinement: the spec originally listed `analyzeCampaignPerformance` as a dependency, but metrics were computed directly from campaign objects. This spec uses `getCampaigns()` directly and computes only the metrics it needs (reply counts). Simpler and avoids an unnecessary import.
