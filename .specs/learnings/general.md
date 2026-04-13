---
name: General Patterns
description: Architecture, design, and implementation patterns that don't fit a specific category
type: feedback
---

# General Patterns

## Thin orchestration layer over existing analytics

When adding a scheduling/reporting layer on top of an existing analytics feature, keep the new code thin: delegate to the underlying function rather than re-implementing its logic. The value of the new feature is what it *adds* (scheduling, persistence, WoW comparison, recommendations) — not repeating what the existing feature already does.

```ts
// Good — delegate, don't duplicate
export async function generateWeeklyReport(options) {
  const currentWeek = await analyzeCampaignPerformance({ _client: options._client });
  const previousWeek = await loadMostRecentSnapshot(snapshotDir);
  // ... scheduling, comparison, recommendations on top of currentWeek
}

// Bad — re-implementing campaign metrics in the weekly report
export async function generateWeeklyReport(options) {
  const campaigns = await client.getCampaigns();
  const replied = campaigns.filter(...); // duplicates analyzeCampaignPerformance
  // ...
}
```

This keeps the feature's footprint small and means any fixes to `analyzeCampaignPerformance` automatically benefit the weekly report. The thin layer is also easier to test — mock one function call instead of the full API.

---

## Name ALL thresholds in analytics/recommendation code

When a function contains multiple numeric thresholds (reply rate floor, dominance factor, stability cutoff, display count cap), extract every one to a named constant at the top of the file — even the "obvious" ones. Analytics code typically has 5–8 tunable values scattered across it.

```ts
// Before refactor — magic numbers scattered:
if (top.replyRatePct >= average * 2) { ... }
if (campaign.sent >= 20 && campaign.replied === 0) { ... }
if (avgReplyRate < 3) { ... }
const top3 = recommendations.slice(0, 3);
if (Math.abs(delta) < 0.05) return 'stable';

// After — all named at the top:
const MAX_RECOMMENDATIONS = 3;
const MIN_SENDS_FOR_PAUSE_REVIEW = 20;
const LOW_REPLY_RATE_THRESHOLD_PCT = 3;
const TOP_CAMPAIGN_DOMINANCE_FACTOR = 2;
const DELTA_STABILITY_THRESHOLD_PP = 0.05;
const TOP_CAMPAIGNS_TO_SHOW = 2;
```

Named constants make tuning obvious, self-document business logic, and ensure the same value is used consistently (the `MIN_SENDS_FOR_PAUSE_REVIEW` appeared in both `generateRecommendations` and `buildReportText` — naming it caught that they must stay in sync).

---

## "Next Monday" date math: guard when today IS Monday

When computing "next occurrence of weekday N" using `getDay()`, the naive formula `(7 - dayOfWeek + targetDay) % 7` returns 0 when today IS the target day. Add 7 in that case:

```ts
function nextMondayString(from: Date = new Date()): string {
  const day = from.getDay(); // 0=Sun, 1=Mon, ...
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
  const next = new Date(from);
  next.setDate(from.getDate() + daysUntilMonday);
  return next.toISOString().split('T')[0];
}
```

Without the `day === 1 ? 7` guard, a report run on Monday would say "Next report: today" — which is wrong for a weekly schedule.

---

## When spec scenario descriptions conflict with the output format, trust the format

A spec can have both a Gherkin scenario description ("calls out any leads that crossed into 'Hot' tier") and an Output Format template (`{newly_warm} crossed into warm` — just a count). These are written at different times and can diverge when the pre-implementation scenario is more aspirational than the implementation-time format.

When the two conflict, the output format section is more grounded — it was written with the actual data model and API response in mind. The scenario description tends to be aspirational and may describe intent that was later simplified. During drift check, reconcile the scenario wording to match the format (not the other way around).

Root cause pattern: spec written before implementation → scenario description is aspirational → implementation follows the format → drift check finds the mismatch. Plan for a post-build wording reconciliation of scenario descriptions against output templates on every feature.

---

## Spec output format templates: mark placeholders as "resolved in code"

Output format sections in specs use `{placeholder}` tokens that can be interpreted multiple ways. The `({change})` secondary parenthetical in a template may mean "show the absolute number" in one reading and "not needed" in the code. After implementation, reconcile the template against actual output and remove or update any tokens that resolved differently than written.

The drift check will catch this, but noting it in the spec's Learnings section (and removing the ambiguous token) is faster than a post-build reconciliation pass.

---

## Separate signal arrays for "problems" vs "recoveries" in report interfaces

When a report interface mixes new-problem alerts with resolved-problem signals, callers must inspect `alert.type` to distinguish them. Prefer two separate arrays:

```ts
interface HealthReport {
  alerts: CampaignAlert[];      // new or ongoing issues
  recoveries: CampaignAlert[];  // previously flagged, now resolved
}
```

This makes the caller contract explicit: `report.alerts.length > 0` means "something broke", `report.recoveries.length > 0` means "something healed". No type inspection needed.

---

## Apply LLM confidence overrides deterministically in the automation layer

When delegating analysis to an LLM that returns confidence classifications (e.g., `'working'` vs `'watch'`), don't trust the LLM to apply your confidence rules correctly. Apply a deterministic post-processing step in the automation:

```ts
function applyConfidenceRules(traits: IcpTrait[]): IcpTrait[] {
  return traits.map((t) => {
    const lowSample = t.sampleSize < MIN_SAMPLE_FOR_HIGH_CONFIDENCE;
    const confidence = lowSample ? 'low' : t.confidence;
    const category = lowSample && t.category === 'working' ? 'watch' : t.category;
    return { ...t, confidence, category };
  });
}
```

This pure function is independently unit-testable, keeps the rule in one named place (`MIN_SAMPLE_FOR_HIGH_CONFIDENCE`), and produces consistent results regardless of what the LLM returned for small-sample traits. The rule: "LLM says 'working' but sample < 10 → reclassify to 'watch'."

---

## Gate proposed output fields to `null` when no high-confidence data exists

When a report can propose a config change (new ICP description, revised thresholds), gate the proposed field to `null` unless at least one high-confidence signal backs it:

```ts
const highConfSuggestions = suggestions.filter((s) => s.confidence === 'high');
const proposedIcp = highConfSuggestions.length > 0 ? analysis.proposedIcp : null;
```

This prevents users from acting on noise. Document the null case in the interface type (`proposedIcp: string | null`) and test it explicitly: "when only low-confidence suggestions exist, `proposedIcp === null`." The `reportText` builder should also hide the "Suggested ICP Update" section when `proposedIcp` is null.

---

## Named factory for duplicate early-return report objects

When two or more early-exit gates return near-identical report objects differing in only 1-2 fields, extract a named factory rather than duplicating inline:

```ts
function makeInsufficientDataReport(
  currentIcp: string, campaignCount: number, totalSent: number, message: string
): IcpRefinementReport {
  return {
    currentIcp, campaignCount, totalSent,
    totalReplied: 0, overallReplyRate: 0,
    traits: { working: [], notWorking: [], inconclusive: [], watch: [] },
    suggestions: [], proposedIcp: null, reportText: message,
  };
}
```

The factory name signals the semantic ("insufficient data, returning empty report") and the varying parameter (`totalSent: 0` vs computed) is explicit at each call site. Avoids 9-field duplication where 8 of 9 fields are identical across two branches.

---

## Spec dependency section drifts when the implementation takes a simpler path

A spec's Dependencies section is written before implementation. If the implementation discovers a simpler approach (e.g., reading `c.metrics` directly instead of calling an existing analytics helper), the dependency listed in the spec becomes incorrect. This will not be caught by scenario tests — only the drift check catches it.

Add dependency-section verification to the post-build drift check: read each listed dependency, confirm it appears in the source file's imports. False dependencies (anticipated helpers that weren't needed) and missing dependencies (helpers that were added during implementation) are both worth flagging.

---

## Normalize union arrays to concrete types before iteration to remove always-true guards

When an array accumulates elements of a union type but all elements at that point are semantically one concrete type, re-declare the array with the concrete type upfront. This eliminates downstream type guards that are always true at runtime but required by TypeScript:

```ts
// Before — union type forces always-true runtime guards downstream
const allLowConf: Array<FeedbackRecommendation | { recommendation: string; dataPoint: string }> = [];
// ...later in buildReportText...
if ('dataPoint' in item) { ... }  // always true — TypeScript requires it but humans see noise

// After — normalize to concrete type at declaration; guards disappear
const allLowConf: Array<{ recommendation: string; dataPoint: string }> = [];
// ...later...
allLowConf.forEach((item) => { /* item.recommendation and item.dataPoint always accessible */ });
```

The root cause is usually an accumulator initialized before its final type is known. When you later realize all branches write the same concrete type, fix the declaration rather than adding runtime guards. Downstream code becomes simpler and the type system stops requiring logic that never runs.

---

## `void unusedResult` for spec-required fetches not yet used in logic

When a spec requires a fetch (for future use or completeness) but the current implementation doesn't consume the result, assign it to `void` to explicitly suppress lint warnings while documenting the intentional fetch:

```ts
// Fetched per spec; not yet used in correlation logic — suppress lint
const [leadsResult, intentCounts] = await Promise.all([fetchAllLeads(client), client.getIntentTypeCounts()]);
void intentCounts; // spec requires this fetch; unused until intent-type correlation is expanded
```

This is clearer than suppressing with a `// eslint-disable` comment or deleting the call — `void` signals "I know this is unused right now" without removing the fetch. When the logic is expanded to use the result, delete the `void` line.

---

## `status` field value and display format can intentionally differ — document both

A data model's `status` field (machine-readable, for serialization and logging) can legitimately differ from the display string shown to the user. Example:

- `status` = `"too early to evaluate — 3/10 sends"` (full prose, stable format for downstream consumers)
- Display = `"too early (3/10 sends)"` (abbreviated, fits the output table)

Document both in the spec's Output Format section and Function Signature. The drift check will flag them as inconsistent if only one is updated. Name the pair in comments in the report builder so the difference is intentional, not accidental.
