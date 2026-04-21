---
feature: Personalized Message Generation
domain: core-pipeline
source: src/automations/message-generation.ts
tests:
  - tests/automations/message-generation.test.ts
components: []
design_refs: []
status: implemented
created: 2026-04-13
updated: 2026-04-21
---

# Personalized Message Generation

**Source File**: src/automations/message-generation.ts
**Design System**: N/A (no UI — automation script)
**Depends on**: GojiBerry API Client (`src/api/gojiberry-client.ts`), Lead Enrichment + Intent Scoring (feature 3, provides fitScore + intentSignals)

## Overview

For enriched leads that score above the intent threshold, generates hyper-personalized LinkedIn messages based on the enrichment data — buying signals, company context, and ICP fit. Stores messages on each lead via `PATCH /v1/contact/{id}` (personalizedMessages field). Messages sit in GojiBerry ready for campaign launch — nothing sends without the founder approving in GojiBerry's UI.

The founder wants messages that sound like they actually read the person's profile. Not "I noticed we're in the same industry" — real references to recent activity, specific pain points, and genuine reasons to connect. This is the difference between a 2% reply rate and a meaningful one.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOJIBERRY_API_KEY` | Yes | Bearer token for GojiBerry API (used by API client) |
| `ANTHROPIC_API_KEY` | Yes | API key for Anthropic (used for message generation via Claude) |
| `ICP_DESCRIPTION` | Yes | Plain-English description of the **target buyer** (who the message is going to) |
| `VALUE_PROPOSITION` | Yes | Plain-English description of **what you sell** (1-3 sentences). Anchors every message. If missing, throws ConfigError — prevents LLM product-name hallucinations |
| `MIN_INTENT_SCORE` | No | Minimum score to consider a lead "warm" and eligible for messaging (default: 50) |
| `MESSAGE_BATCH_SIZE` | No | Max leads to generate messages for per run (default: 25) |
| `MESSAGE_TONE` | No | Tone guidance for messages: "casual", "professional", "direct" (default: "casual") |
| `MESSAGE_MAX_LENGTH` | No | Max character count per message (default: 300 — LinkedIn connection request limit) |

## Feature: Personalized Message Generation

### Scenario: Generate personalized messages for warm leads
Given the founder has warm leads in GojiBerry (fitScore >= MIN_INTENT_SCORE) with intentSignals but no personalizedMessages
And `ICP_DESCRIPTION` is set to "Series A SaaS founders in fintech who are actively hiring"
When the message generation automation runs
Then it fetches warm leads that don't have messages yet
And generates a hyper-personalized LinkedIn message for each lead based on their intentSignals, company, jobTitle, and ICP context
And stores each message on the lead via `PATCH /v1/contact/{id}` with personalizedMessages
And outputs a summary: "{count} messages generated — ready for review in GojiBerry"

### Scenario: Identify leads that need messages
Given GojiBerry contains leads with various states
When the automation fetches leads for messaging
Then it selects leads where fitScore >= MIN_INTENT_SCORE (warm leads)
And skips leads that already have personalizedMessages set (already messaged)
And skips leads with no intentSignals (not yet enriched — nothing to personalize from)
And respects `MESSAGE_BATCH_SIZE` — processes only that many per run
And processes leads in score-descending order (warmest first)

### Scenario: Reject run when ICP description is missing
Given `ICP_DESCRIPTION` is empty or not set in `.env.local`
When the message generation automation runs
Then it throws a `ConfigError` with message: "Missing ICP_DESCRIPTION in .env.local — describe your ideal customer first"
And no messages are generated

### Scenario: Reject run when VALUE_PROPOSITION is missing
Given `VALUE_PROPOSITION` is empty or not set in `.env.local`
When the message generation automation runs
Then it throws a `ConfigError` mentioning `VALUE_PROPOSITION` and "so the LLM does not invent one"
And no messages are generated
And no GojiBerry API calls are made
**Why**: an earlier version of this feature had no VALUE_PROPOSITION slot in the prompt. The LLM, given only ICP + lead info, invented product names to pitch (e.g. "GojiBerry" — the automation platform, not what was being sold). This gate prevents recurrence.

### Scenario: Prompt anchors the LLM to the configured value proposition
Given `VALUE_PROPOSITION` = "SalesEdge runs done-for-you outbound sales ops for mid-market trades companies"
When `buildMessagePrompt` is invoked
Then the prompt contains the value proposition verbatim
And the prompt contains the ICP description
And the prompt contains a "Your Offer" label distinguishing the offer from the target
And the prompt explicitly forbids inventing or naming other products/platforms/tools

### Scenario: Prompt forbids em dashes and en dashes
Given the prompt generator is invoked
When `buildMessagePrompt` is run
Then the returned prompt mentions "em dash" (so the LLM can't rationalize the rule away)
And the prompt includes the literal `—` character (so the instruction is unambiguous)
**Why**: em dashes are the clearest style tell that a message was written by an LLM. Real people typing on phones or laptops use commas, periods, or start new sentences. Forbidding em/en dashes in the prompt keeps outbound messages sounding human.

### Scenario: Generate a message that references real buying signals
Given a lead named "Sarah Chen" at "FinPay" with jobTitle "CEO"
And intentSignals: ["Recently raised Series A ($8M)", "Hiring 3 SDRs", "Posted about scaling outbound"]
And the ICP is about founders scaling outbound
When the automation generates a message for this lead
Then the message references at least one specific buying signal (not generic platitudes)
And the message connects the signal to a relevant value prop
And the message reads like a human wrote it after actually looking at their profile
And the message does NOT include: "I noticed we're both in [industry]", "I came across your profile", or other template phrases

### Scenario: Respect MESSAGE_MAX_LENGTH for LinkedIn connection requests
Given `MESSAGE_MAX_LENGTH` is set to 300
When the automation generates a message
Then each message is at most 300 characters
And the message is complete (not truncated mid-sentence)
And key personalization is preserved even at short lengths

### Scenario: Use default MESSAGE_MAX_LENGTH when not configured
Given `MESSAGE_MAX_LENGTH` is not set in `.env.local`
When the automation runs
Then it uses a default max length of 300 characters (LinkedIn connection request limit)

### Scenario: Respect message tone setting
Given `MESSAGE_TONE` is set to "professional"
When the automation generates messages
Then messages use a professional tone (no slang, proper grammar, business-appropriate)
And personalization quality is maintained regardless of tone

### Scenario: Use default casual tone when MESSAGE_TONE is not configured
Given `MESSAGE_TONE` is not set in `.env.local`
When the automation runs
Then it uses a default tone of "casual"
And messages feel conversational, like a real founder reaching out

### Scenario: Respect message batch size
Given GojiBerry has 40 warm leads without messages
And `MESSAGE_BATCH_SIZE` is set to 15
When the automation runs
Then it generates messages for only the top 15 leads (sorted by fitScore descending — warmest first)
And outputs: "15 messages generated (25 remaining — run again to continue)"

### Scenario: Use default batch size when not configured
Given `MESSAGE_BATCH_SIZE` is not set in `.env.local`
When the automation runs
Then it uses a default batch size of 25

### Scenario: Handle lead with minimal intent signals
Given a lead has fitScore of 55 (above threshold) but only one intentSignal: ["Active on LinkedIn"]
When the automation generates a message for this lead
Then it still produces a personalized message using available data (company, jobTitle, the single signal)
And does NOT fabricate signals that weren't in the data
And logs: "Low signal: {firstName} {lastName} — message generated from limited data"

### Scenario: Handle GojiBerry API errors during message storage
Given the automation is generating messages for 10 leads
And the GojiBerry API returns an error when updating lead #4
When the automation processes the batch
Then it logs: "Failed to save message for: {firstName} {lastName} — {error message}"
And continues generating and storing messages for the remaining leads
And the summary includes the failure count

### Scenario: Handle rate limits during batch messaging
Given the automation is generating messages for 25 leads
And each lead requires 1 PATCH call to GojiBerry (plus 1 Anthropic call for generation)
When updating leads approaches the 100 req/min rate limit
Then the GojiBerry API client handles rate limiting automatically
And all messages are generated and stored without rate limit errors

### Scenario: Handle authentication failure
Given the GojiBerry API key is invalid or expired
When the message generation automation runs
Then it throws an `AuthError` from the API client
And no messages are generated
Note: If the error occurs during message saving (PATCH), the automation logs the AuthError message before re-throwing. If the error occurs during the initial lead fetch (searchLeads), AuthError propagates without additional console output.

### Scenario: Handle Anthropic API failure during generation
Given the automation is generating messages for 10 leads
And the Anthropic API returns an error for lead #3
When the automation processes the batch
Then it logs: "Failed to generate message for: {firstName} {lastName} — {error message}"
And continues with the remaining leads
And the lead is included in the failed count

### Scenario: Output message generation summary
Given the automation generated messages for 12 leads
When the run completes
Then it outputs a summary table with: lead name, company, fitScore, message preview (first 80 chars)
And a totals line: "12 messages generated — ready for review in GojiBerry"
And leads are listed by fitScore descending (warmest first)

### Scenario: Generate messages for a specific lead by ID
Given the founder wants to generate a message for a single lead
When the automation runs with a specific lead ID
Then it fetches that lead from GojiBerry via `GET /v1/contact/{id}`
And validates the lead has intentSignals and fitScore >= threshold
And generates and stores the message
And outputs: "{firstName} {lastName} — message ready: {preview}"

### Scenario: Regenerate messages (force refresh)
Given a lead already has personalizedMessages set
And the founder wants to regenerate with updated signals or a new tone
When the automation runs with the `forceRegenerate` option enabled
Then it regenerates messages even for leads that already have personalizedMessages
And overwrites the previous messages in GojiBerry
And logs: "Regenerated: {firstName} {lastName}"

### Scenario: Skip leads below intent threshold
Given a lead has fitScore of 30 (below MIN_INTENT_SCORE of 50)
When the automation fetches leads for messaging
Then this lead is not included in the batch
And no message is generated for cold leads

## Module Structure

```
src/automations/
├── message-generation.ts   # Main automation — orchestrates fetch + generate + store
├── types.ts                # Shared types (extend with MessageGeneratorFn type)
```

## Public API Surface

```typescript
// In types.ts — add alongside existing types
type MessageGeneratorFn = (
  lead: Lead,
  icpDescription: string,
  options: { tone: string; maxLength: number }
) => Promise<string>;

// In message-generation.ts
interface MessageResult {
  lead: Lead;
  message: string;           // The generated personalized message
}

interface MessageGenerationResult {
  generated: MessageResult[];                    // Successfully generated + stored
  failed: { lead: Lead; error: string }[];       // Generation or storage failures
  skipped: Lead[];                                // Already have messages (no forceRegenerate)
  remaining: number;                              // Warm leads still needing messages
}

// Use Pick<> pattern — only declare the client methods this module actually calls
// (Per learnings: eliminates `as unknown as Client` casts in tests)
type MessageGenClient = Pick<GojiBerryClient, 'searchLeads' | 'getLead' | 'updateLead'>;

// Exported options interface (named export — usable by callers and tests)
export interface GenerateMessagesOptions {
  leadId?: string;              // Generate for a single lead by ID
  forceRegenerate?: boolean;    // Overwrite existing messages
  batchSize?: number;           // Override MESSAGE_BATCH_SIZE
  minIntentScore?: number;      // Override MIN_INTENT_SCORE
  icpDescription?: string;      // Override ICP_DESCRIPTION
  tone?: string;                // Override MESSAGE_TONE
  maxLength?: number;           // Override MESSAGE_MAX_LENGTH
  _messageGenerator?: MessageGeneratorFn;  // Test-only: inject mock generator
  _client?: MessageGenClient;              // Test-only: inject mock GojiBerry client
}

// Default message generator using Anthropic Claude (exported — injectable in tests)
export async function defaultMessageGenerator(
  lead: Lead,
  icpDescription: string,
  options: { tone: string; maxLength: number },
): Promise<string>

export async function generateMessages(
  options?: GenerateMessagesOptions,
): Promise<MessageGenerationResult>

// Reuse resolvePositiveNumber from lead-enrichment.ts for option→env→default resolution
```

## Data Flow

```
1. Read ICP_DESCRIPTION + MIN_INTENT_SCORE + MESSAGE_* vars from .env.local
           │
2. Fetch warm leads from GojiBerry
   searchLeads({ scoreFrom: MIN_INTENT_SCORE, pageSize: 500 }) — fetches up to 500 leads
   to ensure client-side filtering has enough candidates (FETCH_PAGE_SIZE = 500 constant)
   THEN client-side filter:
     - Remove leads that already have personalizedMessages (unless forceRegenerate)
     - Remove leads with no intentSignals (nothing to personalize from)
     - Sort by fitScore descending (warmest first)
     - Limit to MESSAGE_BATCH_SIZE
   NOTE: GojiBerry LeadFilters does NOT support filtering by intentSignals
   presence or personalizedMessages absence — these must be client-side
           │
3. For each lead:
   ├── Build prompt with: lead profile, intentSignals, ICP description, tone, max length
   ├── Claude generates a personalized LinkedIn message
   └── Message references specific buying signals — no generic templates
           │
4. Store message on each lead:
   PATCH /v1/contact/{id} with { personalizedMessages: [message] }
           │
5. Output summary table + totals
           │
6. Messages sit in GojiBerry — founder reviews and approves in the UI before campaign launch
```

## Key Design Decisions

### Message generation is LLM-delegated, not template-based

Like enrichment delegates scoring to Claude, message generation delegates writing to Claude. The prompt includes the lead's profile, buying signals, ICP context, and tone guidance. Claude writes the message. This avoids the template trap — every message is unique because the inputs are unique.

### personalizedMessages is a string array

The GojiBerry API stores `personalizedMessages` as `string[]`. For now, we generate one message per lead (the array contains a single element). Future iterations could generate variants (A/B test different hooks) — the data model supports it without changes.

### Warmest leads first

Unlike enrichment (FIFO — oldest first), message generation prioritizes by fitScore descending. The founder's warmest leads get messages first because those are most likely to reply. If the batch size cuts off, cold-ish leads above threshold wait for the next run.

### Tone is configurable but defaults to casual

Most founders doing LinkedIn outreach get better reply rates with casual, human messages. The `MESSAGE_TONE` env var lets users adjust, but the default is conversational — "hey Sarah, saw you just raised your Series A" not "Dear Ms. Chen, I noticed your recent funding round."

### 300-character default matches LinkedIn connection requests

LinkedIn connection request messages are capped at 300 characters. Since this is the primary use case (cold outreach to people you're not connected with), the default max length matches this constraint. Users doing InMail (which allows longer messages) can increase it.

### No messages for leads without intent signals

A lead with a fitScore but no intentSignals has nothing to personalize from. The message would inevitably be generic. Better to skip and let the founder know these leads need enrichment first.

### Client-side filtering is unavoidable

The GojiBerry `LeadFilters` API supports `scoreFrom`/`scoreTo` but not filtering by `intentSignals` presence or `personalizedMessages` absence. This means step 2 of the data flow must fetch all warm leads (by score) and then filter client-side. For large lead databases, this could mean fetching more leads than needed — but at 100 req/min rate limit and typical batch sizes of 25, pagination shouldn't be an issue in practice.

### Reuse `resolvePositiveNumber` from enrichment

The `resolvePositiveNumber(optionValue, envKey, defaultValue)` helper in `lead-enrichment.ts` already handles the option→env→default resolution pattern with `Number("")` guard. Extract to a shared utility or import from enrichment rather than reimplementing.

## Learnings

- **`FETCH_PAGE_SIZE = 500`**: The batch fetch uses `pageSize: 500` to fetch a large page of warm leads before client-side filtering. This ensures `batchSize` leads can always be filled even after filtering out already-messaged or signal-less leads.
- **`defaultMessageGenerator` is exported**: Makes it injectable in tests and reusable in other automations without duplicating the Anthropic setup.
- **`enforceMaxLength` uses sentence boundary**: When a generated message exceeds `maxLength`, it truncates at the last period past 50% of the limit to preserve complete sentences. If no such period exists, it hard-truncates.
- **`GenerateMessagesOptions` is a named export**: Allows callers to type their option objects without importing the implementation.
- **`resolvePositiveNumber` imported from `lead-enrichment.ts`**: Not reimplemented — direct import. Consistent option→env→default resolution across all automations.

### 2026-04-21

- **Product-name hallucinations happen when the prompt lacks an offer anchor.** Before this session, `buildMessagePrompt` only passed `ICP_DESCRIPTION` (who to reach), no slot for what the sender sells. The LLM had to invent a product to make the pitch coherent; in one live case it produced "GojiBerry" (our automation platform) as the pitched product, sent to James Diffenderfer on Monday 3:18 PM. Fix: require `VALUE_PROPOSITION` env var, surface it as a distinct "Your Offer" slot, and add the rule "this is the ONLY product/service you may reference — do NOT invent or name any other product, platform, tool, or company." If `VALUE_PROPOSITION` is missing/empty, `ConfigError` before any API call.
- **Em dashes are the clearest LLM style tell.** Real people typing on phones and laptops use commas, periods, or just start a new sentence. The prompt now explicitly forbids `—` and `–` by naming them AND including the literal `—` character so the rule is unambiguous. Tests assert both appear in the prompt. Also removed em dashes from `VALUE_PROPOSITION` itself — the LLM mirrors its anchor's style.
- **Plan/apply architecture for message regeneration mirrors Apollo enrichment.** `/regenerate-messages` slash command uses headless `regen-plan.cli.ts` to filter candidates against master, Claude-in-session to generate messages inline using current signals + VALUE_PROPOSITION, then `regen-apply.cli.ts` writes via `updateLead`. No ANTHROPIC_API_KEY needed; compatible with Claude Code Desktop scheduled tasks.
- **"Already sent in campaign" gate prevents audit confusion.** Regeneration skips contacts where `gojiberryState.campaignStatus` shows a `{type: 'message', stepNumber: >= 1}` event. Overwriting stored message text doesn't un-send it, but it creates a mismatch between "what went out" and "what's on record." Skip is correct.
- **`--contains TOKEN` surgical regeneration for hallucination cleanup.** When you need to fix only messages containing a specific banned term (e.g., `--contains gojiberry`), the flag targets those without touching anything else. Implies `--force` (otherwise the "already-messaged" gate would skip them).
- **Mechanical em-dash → comma replacement for already-approved content.** When 23 pending messages had em dashes from the pre-rule era, the content was fine — only the punctuation needed fixing. Regex swap (`/\s*[—–]\s*/g → ', '`) preserved intent without regenerating.
