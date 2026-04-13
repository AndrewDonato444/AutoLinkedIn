---
name: API & Data Patterns
description: HTTP client design, error handling, rate limiting, and env config patterns
type: feedback
---

# API & Data Patterns

## Load `.env.local` from `process.cwd()`, not `__dirname`

**Why:** `__dirname` resolves relative to the compiled file's location (e.g., `dist/api/`), not the project root. Scripts run with `tsx` or `node` set `cwd` to the project root, where `.env.local` actually lives.

```ts
dotenv.config({ path: path.join(process.cwd(), '.env.local') });
```

This works regardless of how deep the source file is in the directory tree.

---

## Throw errors in library code — never `process.exit()`

When writing a client that will be imported by other scripts, throw a typed error on misconfiguration rather than calling `process.exit()`. Let callers decide how to handle it.

```ts
// Good — library style
throw new ConfigError('Missing GOJIBERRY_API_KEY ...');

// Bad — kills the whole process, untestable, not reusable
process.exit(1);
```

Specs written aspirationally may say "exits" — correct the spec language to "throws" when the implementation is a library, not a CLI entrypoint.

---

## Two-tier 404 strategy: internal vs. public errors

Use two separate error types for "resource not found" to keep routing logic in one place while giving callers clean public errors:

1. **`Http404Error`** — thrown by the base `request()` method when it sees a 404 response. Internal only.
2. **`NotFoundError`** — thrown by resource methods (e.g., `getLead`, `getList`) after catching `Http404Error`. Carries the resource name and ID for human-readable messages.

This concentrates HTTP status handling in `request()` and resource-specific messaging in each method, without duplicating try/catch everywhere. The `getById<T>` helper further consolidates the pattern for GET-by-ID methods:

```ts
private async getById<T>(urlPath: string, resourceName: string, id: string): Promise<T> {
  try {
    return await this.request<T>('GET', `${urlPath}/${id}`);
  } catch (err) {
    if (err instanceof Http404Error) {
      console.log(`${resourceName} ${id} not found in GojiBerry`);
      throw new NotFoundError(resourceName, id);
    }
    throw err;
  }
}
```

Methods with different HTTP verbs or post-success logic (e.g., `updateLead` using PATCH) keep their own inline handlers and don't use `getById`.

---

## Sliding window rate limiter with timestamp array

Prefer a sliding window over a fixed window for rate limiting:

```ts
class RateLimiter {
  private timestamps: number[] = [];
  async throttle() {
    const now = Date.now();
    const windowStart = now - 60_000;
    this.timestamps = this.timestamps.filter(t => t > windowStart); // prune old
    if (this.timestamps.length >= this.limit) {
      const waitMs = this.timestamps[0] - windowStart;
      await sleep(waitMs);
      return this.throttle();
    }
    this.timestamps.push(now);
  }
}
```

Sliding windows prevent the burst-at-boundary problem of fixed windows (where 100 req at :59 and 100 req at :01 = 200 req in 2 seconds).

---

## AbortController + setTimeout for request timeout

Use native `AbortController` with `setTimeout` rather than a Promise.race or third-party timeout wrapper:

```ts
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
try {
  response = await fetch(url, { signal: controller.signal, ... });
} catch (err) {
  if (err instanceof Error && err.name === 'AbortError') throw new TimeoutError();
  throw err;
} finally {
  clearTimeout(timeoutId);
}
```

Always `clearTimeout` in the success path too, or timers accumulate during tests.

---

## Exponential backoff formula

For retry with exponential backoff (base 1s, max 3 retries → 1s, 2s, 4s):

```ts
const attempt = MAX_RETRIES - retriesLeft; // 0 on first retry
const delayMs = BASE_DELAY_MS * Math.pow(2, attempt); // 1000, 2000, 4000
```

Extract `MAX_RETRIES` and `RETRY_BASE_DELAY_MS` as private static class constants — not module-level variables — to keep them scoped to the class.

---

## Guard env var number parsing against empty string

`Number("")` returns `0`, not `NaN`. An env var set to an empty string (`DAILY_LEAD_SCAN_LIMIT=""`) silently produces 0 if you parse directly:

```ts
// WRONG — "" → Number("") = 0, which fails the > 0 guard and may fall through silently
const limit = Number(process.env.DAILY_LEAD_SCAN_LIMIT) || DEFAULT_LIMIT; // 0 || 50 = 50 ✓ (accidentally works here)

// RIGHT — coerce the empty string to the default BEFORE calling Number()
const rawLimit = Number(process.env.DAILY_LEAD_SCAN_LIMIT || DEFAULT_LIMIT);
const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
```

Always coerce falsy (empty string, undefined) to a known default before calling `Number()` on user-supplied env vars.

---

## `as any` for unreleased SDK tool types, with inline comment

When using a tool type that exists in the API but not yet in the SDK's TypeScript definitions, cast to `any` with an explanatory comment rather than contorting the types:

```ts
tools: [{ type: 'web_search_20250305', name: 'web_search' }] as any,
// web_search_20250305 is not yet in the SDK's ToolUnion types — cast required
```

This is preferable to `as unknown as ToolDefinition[]` gymnastics. Remove the cast when the SDK is updated.

---

## Delegate ranking to the LLM prompt rather than implementing it in code

When building a pipeline that needs to rank results by a semantic criterion (ICP fit, relevance, priority), instruct the model to return results pre-ranked instead of implementing a scoring function:

```
// In the prompt:
"Find as many real matching people as you can. Rank them from best ICP fit to weakest."
```

Then just `slice(0, limit)` the array. This is simpler, produces better results (the LLM understands the ICP semantically), and eliminates a scoring algorithm to test and maintain. The spec should say "ranking delegated to web search" not "ranked by the automation."

---

## Extract a `resolvePositiveNumber` helper when option-override + env + default repeats

When a function parameter and an env var can both override a numeric default, the inline pattern repeats across multiple values. Extract a helper:

```ts
// Repeated inline (brittle, hard to read):
const batchSize = options?.batchSize ?? Number(process.env.ENRICHMENT_BATCH_SIZE || 25);
const minScore = options?.minIntentScore ?? Number(process.env.MIN_INTENT_SCORE || 50);

// Named helper (clear, DRY):
function resolvePositiveNumber(
  optionValue: number | undefined,
  env: string | undefined,
  defaultValue: number
): number {
  const n = optionValue ?? Number(env || defaultValue);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}
```

The helper also handles the `Number("")` = 0 gotcha (previously documented) in one place.

---

## Auth error split behavior by loop position — document each phase in specs

When an automation has a fetch phase + a per-item processing loop, AuthError behavior differs by location:

- **Before the loop** (e.g., `searchLeads`): AuthError propagates naturally — no catch, no log, no console output.
- **Inside the loop** (e.g., `updateLead`): AuthError can be caught per-item, logged, and re-thrown or skipped.

Specs written at a high level ("auth fails → outputs message") will diverge from the implementation. Always document:
- Which phase the error occurs in
- Whether it's logged before re-throwing or silently propagated

The drift check will catch this, but writing it correctly upfront avoids the reconciliation pass.

---

## `Promise.all()` for parallel independent API fan-out

When a function needs data from N endpoints that don't depend on each other, fetch them all in parallel:

```ts
const [{ leads, total }, byIntentType, campaigns, lists] = await Promise.all([
  fetchAllLeads(client),
  client.getIntentTypeCounts(),
  client.getCampaigns(),
  client.getLists(),
]);
```

Any rejection propagates immediately (fail-fast). Sequential `await` calls are 4× slower for no reason when the fetches are independent. Destructure the tuple to keep the variables named.

---

## `do...while` for API pagination

When paginating, use `do...while` so page 1 is always fetched before checking the termination condition:

```ts
do {
  const result = await client.searchLeads({ page, pageSize: PAGE_SIZE });
  total = result.total;
  allLeads.push(...result.leads);
  page++;
} while (allLeads.length < total);
```

A `while`-with-pre-check would skip the first fetch if `total` were somehow 0 before the first call — which is impossible here, but `do...while` makes the intent obvious. Avoids off-by-one issues when results span exactly one page.

---

## Guard both `undefined` and `null` for optional API numeric fields

When an API may return `null` explicitly or omit a field entirely, check for both:

```ts
if (score === undefined || score === null) return 'unscored';
```

`score === undefined` alone misses `null`. `score == null` (loose equality) works but is easy to confuse with `score === null`. The explicit two-check form is the clearest and safest.

---

## `Record<string, unknown>` for optional filter accumulation

When building an API filter object with optional keys, use a `Record<string, unknown>` base and conditionally assign keys only when they're defined:

```ts
const apiFilters: Record<string, unknown> = { scoreFrom: minScore, scoreTo: maxScore };
if (filters?.dateFrom) apiFilters.dateFrom = filters.dateFrom;
if (filters?.dateTo) apiFilters.dateTo = filters.dateTo;
if (filters?.intentType) apiFilters.intentType = filters.intentType;
```

This keeps absent optional fields out of the object entirely (some APIs treat `{ intentType: undefined }` differently from `{}`). Cast to the typed filter at the call site with `as Parameters<typeof client.searchLeads>[0]`. Prefer this over a typed interface with all-optional fields, which would still require explicit `undefined` removal before the call.

---

## ISO date filenames give free lexicographic-chronological sort

When storing time-series data as separate files (snapshots, daily reports, audit logs), name files with ISO 8601 dates (`YYYY-MM-DD.json`). Alphabetical order == chronological order, so finding the most recent file requires no date parsing:

```ts
const files = fs.readdirSync(snapshotDir).filter(f => f.endsWith('.json')).sort();
const mostRecent = files.reverse()[0]; // last alphabetically = most recent date
```

This also makes the directory listing immediately human-readable and enables glob patterns like `2026-04-*.json` for month filtering. Avoid epoch timestamps or `DD-MM-YYYY` formats — they break naive sort.

---

## Sequential-then-parallel fetch for AuthError propagation gate

When a function fetches from multiple endpoints and one of them is a natural auth gate (e.g., `getCampaigns` is the first meaningful call), fetch it sequentially first, then run the remaining independent fetches in parallel:

```ts
// Sequential gate — AuthError propagates before other fetches start
const campaigns = await client.getCampaigns();

// Parallel fetches — only run if the gate passed
const [leadsResult, intentCounts] = await Promise.all([
  fetchAllLeads(client),
  client.getIntentTypeCounts(),
]);
```

**Why not `Promise.all([getCampaigns, fetchAllLeads, getIntentTypeCounts])`?** With all three in parallel, `getCampaigns` can fail with `AuthError` but the other two calls may have already started — partial work against an unauthorized API. The sequential-then-parallel split ensures the auth check completes before any downstream work begins, matching the spec's "AuthError → does not produce a partial report" invariant.

Verify with a test: mock `getCampaigns` to throw `AuthError`, assert `searchLeads` was never called.

---

## `intentType: 'replied'` as reply-status proxy + set-diff for segmentation

When an API's filter supports `intentType` as a string but has no per-lead reply-status field, use `intentType: 'replied'` as a proxy filter. Derive the complementary segment (non-replied) by fetching all leads and subtracting the replied IDs via a `Set`:

```ts
const [repliedResult, allLeadsResult] = await Promise.all([
  client.searchLeads({ intentType: 'replied' }),
  client.searchLeads(),
]);
const repliedIds = new Set(repliedResult.leads.map((l) => l.id));
const nonReplied = allLeadsResult.leads.filter((l) => !repliedIds.has(l.id));
```

The two calls run in parallel (`Promise.all`). The Set-diff avoids a nested loop. Apply this pattern whenever the API exposes one segment but not its complement — fetch both, subtract.

---

## Don't duplicate `sleep` across files — just inline it

A one-line `sleep` function is so small that creating a shared utility file adds more complexity (import paths, another file to maintain) than it saves. Each file that needs it can define it locally:

```ts
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

Per SDD guidelines: three similar lines is better than a premature abstraction.
