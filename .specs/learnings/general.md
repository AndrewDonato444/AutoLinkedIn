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

## Spec output format templates: mark placeholders as "resolved in code"

Output format sections in specs use `{placeholder}` tokens that can be interpreted multiple ways. The `({change})` secondary parenthetical in a template may mean "show the absolute number" in one reading and "not needed" in the code. After implementation, reconcile the template against actual output and remove or update any tokens that resolved differently than written.

The drift check will catch this, but noting it in the spec's Learnings section (and removing the ambiguous token) is faster than a post-build reconciliation pass.
