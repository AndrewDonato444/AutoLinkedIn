---
feature: Daily Lead Scan Automation
domain: automation
source: src/automations/daily-lead-scan.ts
tests:
  - tests/automations/daily-lead-scan.test.ts
components: []
design_refs: []
status: implemented
created: 2026-04-13
updated: 2026-04-13
---

# Daily Lead Scan Automation

**Source File**: src/automations/daily-lead-scan.ts
**Depends On**: ICP-based Lead Discovery (Feature 2), Lead Enrichment + Intent Scoring (Feature 3), Personalized Message Generation (Feature 4)

## Overview

Scheduled automation (cron via `DAILY_SCAN_CRON`) that runs the full pipeline: discover leads → create in GojiBerry → enrich with intent signals → generate personalized messages. The founder wakes up to new leads with messages ready to approve — no manual steps required.

This is the "set it and forget it" automation. The founder defines their ICP once, configures a schedule, and checks GojiBerry when leads are ready. The daily scan respects `DAILY_LEAD_SCAN_LIMIT` to prevent burning through too many API calls or flooding the pipeline with unreviewed leads.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOJIBERRY_API_KEY` | Yes | — | Bearer token for GojiBerry API |
| `ICP_DESCRIPTION` | Yes | — | Plain-English ideal customer description |
| `DAILY_SCAN_CRON` | No | `0 7 * * 1-5` | Cron schedule (default: weekdays at 7am) |
| `DAILY_LEAD_SCAN_LIMIT` | No | `10` | Max new leads to discover per run |
| `MIN_INTENT_SCORE` | No | `50` | Minimum intent score for message generation |
| `MESSAGE_TONE` | No | — | Tone for generated messages (passed to message generation) |
| `MESSAGE_MAX_LENGTH` | No | — | Max message length (passed to message generation) |

## Feature: Daily Lead Scan Automation

### Scenario: Run the full pipeline — discover, enrich, generate messages
Given the founder has configured `ICP_DESCRIPTION` and `GOJIBERRY_API_KEY`
And `DAILY_LEAD_SCAN_LIMIT` is set to 10
When the daily lead scan runs
Then it calls `discoverLeads()` with the ICP description and lead limit
And it calls `enrichLeads()` on the newly created leads
And it calls `generateMessages()` for leads scoring above `MIN_INTENT_SCORE`
And it outputs a summary: "{n} leads found, {n} enriched, {n} messages generated"

### Scenario: Lead limit caps discovery
Given `DAILY_LEAD_SCAN_LIMIT` is set to 5
And there are more than 5 potential leads matching the ICP
When the daily lead scan runs
Then `discoverLeads()` is called with `limit: 5`
And at most 5 leads are created in GojiBerry
And the summary notes how many were capped ("5 leads found (limit: 5)")

### Scenario: Some leads already exist in GojiBerry (duplicates skipped)
Given the ICP matches leads that are already contacts in GojiBerry
When the daily lead scan runs
Then `discoverLeads()` skips duplicates (by profileUrl)
And the summary reports: "{n} new leads, {n} skipped (already in pipeline)"
And only new leads proceed to enrichment

### Scenario: Enrichment scores some leads below threshold
Given the daily scan discovers 10 leads
And after enrichment, 6 score above `MIN_INTENT_SCORE` and 4 score below
When enrichment completes
Then message generation runs only for the 6 leads above threshold
And the summary reports: "6 leads above intent threshold, 4 below — messages generated for 6"

### Scenario: All leads score below intent threshold
Given the daily scan discovers 5 leads
And all 5 score below `MIN_INTENT_SCORE` after enrichment
When enrichment completes
Then message generation is skipped entirely
And the summary reports: "5 leads found and enriched, 0 above intent threshold — no messages generated"
And the summary suggests: "Consider broadening your ICP or lowering the intent threshold"

### Scenario: Discovery finds zero leads
Given the ICP description doesn't match any new leads
When the daily lead scan runs
Then `discoverLeads()` returns zero created leads
And enrichment and message generation are skipped
And the summary reports: "No new leads found matching your ICP today"
And the summary suggests: "This can happen when your ICP is very specific — consider broadening it"

### Scenario: Discovery fails (API error or web search failure)
Given `discoverLeads()` throws an error during execution
When the daily lead scan runs
Then it catches the error and does not proceed to enrichment
And it outputs: "Daily scan failed at discovery: {error message}"
And no partial results are saved

### Scenario: Enrichment fails partway through a batch
Given the daily scan discovers 8 leads successfully
And `enrichLeads()` succeeds for 5 leads but fails for 3
When enrichment completes with partial results
Then message generation runs for the 5 successfully enriched leads above threshold
And the summary reports failures: "5 enriched, 3 failed enrichment"
And it lists the failed leads with error reasons

### Scenario: Message generation fails for some leads
Given enrichment succeeds and 6 leads qualify for messages
And `generateMessages()` succeeds for 4 but fails for 2
When message generation completes
Then the summary reports: "4 messages generated, 2 failed"
And successfully generated messages are still saved to GojiBerry
And the summary lists which leads had message failures

### Scenario: API authentication failure aborts immediately
Given the `GOJIBERRY_API_KEY` is invalid or expired
When the daily lead scan runs
Then it detects the `AuthError` from the first API call
And it aborts the entire scan immediately
And it outputs: "Daily scan aborted — API authentication failed. Check your GOJIBERRY_API_KEY."
And no partial results are saved

### Scenario: Missing ICP description prevents scan
Given `ICP_DESCRIPTION` is not set or is empty
When the daily lead scan runs
Then it aborts before calling any APIs
And it outputs: "Daily scan aborted — ICP_DESCRIPTION is required. Define your ideal customer to start scanning."

### Scenario: Save scan results for reporting
Given the daily scan completes (fully or partially)
When the scan finishes
Then it saves a scan log to `data/scan-logs/{date}.json`
And the log includes: date, leads discovered, leads enriched, leads messaged, failures, duration
And the log can be read by the morning briefing for overnight change tracking

### Scenario: Schedule daily scan via cron
Given `DAILY_SCAN_CRON` is set to `0 7 * * 1-5` (weekdays at 7am)
When the automation scheduler evaluates the cron expression
Then it runs the daily lead scan at the configured time
And the scan completes before the morning briefing (default 8am)

### Scenario: Rate limiting across pipeline stages
Given the scan needs to make many API calls across discover, enrich, and generate
And the GojiBerry API rate limit is 100 requests per minute
When any stage approaches the rate limit
Then the underlying API client handles rate limiting (backoff and retry)
And the scan does not fail due to rate limits alone

## Output Format

```
=== Daily Lead Scan ({date}) ===

Discovery: {discovered} new leads found, {skipped} skipped (duplicates)
           {or "No new leads found matching your ICP today"}
           {if limit hit: "(limit: {DAILY_LEAD_SCAN_LIMIT})"}

Enrichment: {enriched} leads enriched, {enrichment_failed} failed
            {above_threshold} above intent threshold ({MIN_INTENT_SCORE}+)
            {below_threshold} below threshold

Messages: {messages_generated} messages generated, {message_failed} failed
          {or "Skipped — no leads above intent threshold"}

--- Failures ---
  {if any failures:}
  - {firstName} {lastName}: {error_reason}
  {else: "None"}

--- Summary ---
  Pipeline: {discovered} → {enriched} → {messages_generated} messages ready
  {next_action}
  Duration: {duration}s

Next scan: {next_run_date}
```

### Next Actions (by outcome)

| Outcome | Next action |
|---------|-------------|
| Messages generated | "Open GojiBerry to review and approve {n} new messages" |
| Leads found but none above threshold | "Consider broadening your ICP or lowering the intent threshold" |
| No leads found | "This can happen when your ICP is very specific — consider broadening it" |
| Partial failures | "Some leads had errors — review failures above and re-run if needed" |

## Function Signature

```typescript
export interface DailyScanOptions {
  /** Override ICP_DESCRIPTION from env */
  icpDescription?: string;
  /** Override DAILY_LEAD_SCAN_LIMIT from env */
  leadLimit?: number;
  /** Override MIN_INTENT_SCORE from env */
  minIntentScore?: number;
  /** Override MESSAGE_TONE from env */
  messageTone?: string;
  /** Override MESSAGE_MAX_LENGTH from env */
  messageMaxLength?: number;
  /** Test-only: inject mock discovery function */
  _discoverLeads?: typeof discoverLeads;
  /** Test-only: inject mock enrichment function */
  _enrichLeads?: typeof enrichLeads;
  /** Test-only: inject mock message generation function */
  _generateMessages?: typeof generateMessages;
  /** Test-only: override scan log directory */
  _scanLogDir?: string;
}

export interface DailyScanResult {
  date: string;
  discovery: DiscoveryResult;
  enrichment: EnrichmentResult | null;
  messageGeneration: MessageGenerationResult | null;
  aboveThreshold: number;
  belowThreshold: number;
  failures: { lead: string; stage: 'discovery' | 'enrichment' | 'messages'; error: string }[];
  nextAction: string;
  durationMs: number;
  summaryText: string;
}

export async function runDailyLeadScan(
  options?: DailyScanOptions,
): Promise<DailyScanResult>;
```

## Dependencies

- `discoverLeads()` from `src/automations/icp-lead-discovery.ts` — web search + contact creation
- `DiscoveryResult` from `src/automations/types.ts`
- `enrichLeads()` from `src/automations/lead-enrichment.ts` — intent scoring + enrichment
- `EnrichmentResult` from `src/automations/types.ts`
- `generateMessages()` from `src/automations/message-generation.ts` — personalized message generation
- `MessageGenerationResult` from `src/automations/types.ts`
- `GojiBerryClient` from `src/api/gojiberry-client.ts` (used indirectly via composed functions)
- `fs` for writing scan logs to `data/scan-logs/`

## Scan Log Storage

Scan logs are stored as JSON files in `data/scan-logs/`:

```
data/scan-logs/
  2026-04-13.json
  2026-04-14.json
  ...
```

Each file contains a `DailyScanResult` object (minus `summaryText` to keep logs machine-readable). The morning briefing and weekly report can read these logs for overnight-change tracking and weekly trend analysis.

The `_scanLogDir` option in the function signature allows tests to use a temp directory.

## Design Decisions

1. **Compose existing automations, don't re-implement**: Calls `discoverLeads()`, `enrichLeads()`, and `generateMessages()` in sequence. Each function handles its own API calls, rate limiting, and error handling. The daily scan orchestrates the pipeline and aggregates results.

2. **Partial failure tolerance at the stage level**: If enrichment partially fails, message generation still runs for successfully enriched leads. If message generation partially fails, successfully generated messages are still saved. Only `AuthError` aborts the entire scan — everything else degrades gracefully.

3. **Discovery failure is a hard stop**: Unlike enrichment/message partial failures, if discovery itself fails there's nothing to enrich or message. The scan reports the error and exits.

4. **Lead limit prevents pipeline flooding**: Without a cap, an aggressive ICP could surface 50+ leads daily, overwhelming the founder's review queue. `DAILY_LEAD_SCAN_LIMIT` defaults to 10 — enough to keep the pipeline moving without creating review fatigue.

5. **Scan runs before the morning briefing**: Default cron is 7am, morning briefing is 8am. The briefing picks up overnight scan results and presents them. This ordering is intentional but not enforced — if a user configures different schedules, the briefing still works (it just might not include the latest scan).

6. **Scan logs are separate from briefing snapshots**: Scan logs capture the full pipeline execution (discovery → enrichment → messages). Briefing snapshots capture the pipeline state at briefing time. They serve different purposes and are stored separately.
