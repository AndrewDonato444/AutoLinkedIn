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

## Derive `remaining` from filtered eligibles, not `page.total`

When fetching a large page for client-side filtering, compute the `remaining` count from the filtered-eligible count minus the batch size — not from `page.total`:

```ts
// WRONG — page.total includes already-messaged and signal-less leads
result.remaining = page.total - batchSize; // inflated — misleads the user

// RIGHT — remaining is eligible leads that didn't fit in this batch
const eligible = page.leads
  .filter((l) => !(l.personalizedMessages?.length))
  .filter((l) => (l.intentSignals?.length ?? 0) > 0);
const toProcess = eligible.slice(0, batchSize);
result.remaining = eligible.length - toProcess.length; // ✓
```

**Why it matters:** `page.total` is the pre-filter API count. If 200 warm leads exist, 150 already have messages, and `batchSize=25`, the correct remaining is 25 (50 eligible − 25 processed), not 175. A remaining count derived from `page.total` would show the user false urgency.

Applies whenever a batch function fetches a large page for client-side filtering — always chain the `remaining` calculation after all filter passes.

---

## Sentence-boundary truncation for LLM output with hard character limits

When LLM-generated text must fit a hard character limit (LinkedIn connection request: 300 chars, SMS: 160 chars), truncate at the last sentence boundary rather than cutting mid-word or mid-sentence:

```ts
function enforceMaxLength(message: string, maxLength: number): string {
  if (message.length <= maxLength) return message;
  const truncated = message.slice(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('.');
  // Use sentence boundary if it's past 50% of the limit (preserves meaningful content)
  return lastPeriod > maxLength * 0.5 ? message.slice(0, lastPeriod + 1) : truncated;
}
```

The 50% floor prevents truncating to a single short sentence when the period is near the start. If no useful period exists, fall back to hard truncation. Also document the `maxLength` default in the spec — e.g., 300 matches LinkedIn's connection request limit and should be the named-constant default.

Note: prompt the LLM to stay under the limit too (`"Keep it under ${maxLength} characters — hard limit"`), but enforce programmatically because LLMs sometimes exceed stated constraints.

---

## Don't duplicate `sleep` across files — just inline it

A one-line `sleep` function is so small that creating a shared utility file adds more complexity (import paths, another file to maintain) than it saves. Each file that needs it can define it locally:

```ts
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

Per SDD guidelines: three similar lines is better than a premature abstraction.

## MCP tool responses are large; extract minimal fields in-process

**Context:** Apollo `people_bulk_match` returns ~2,000+ lines of JSON per batch (organization keywords, employment history, photo URLs, etc.). When a Claude-Code session invokes an MCP tool and the response exceeds token limits, the harness writes the full output to a temp file and returns a path.

**Pattern:** Don't read the full MCP response into Claude's context. Fetch with Node, `JSON.parse` the temp file, extract only the fields your downstream code consumes (for Apollo: `id`, `linkedin_url`, `email`, `email_status`), write the compact form to a proper data file, then proceed.

**Why:** Keeps Claude's context small and makes the intermediate data auditable. 5 Apollo batches × 80KB raw = 400KB; compact form is ~5KB.

---

## Apollo's bulk_match doesn't echo back the correlation `id` you sent

**Gotcha:** The MCP schema documents `id` on each input as "optional unique identifier... used to match results." It is NOT echoed in the response. If you pass 10 contacts and get 10 matches back, you can't correlate them by `id` — you correlate by `linkedin_url`, which Apollo normalizes (https→http, strips trailing slash, drops www).

**Fix:** Normalize URLs before comparing. A centralized `normalizeLinkedInUrl` util at `src/utils/linkedin-url.ts` canonicalizes to `http://linkedin.com/<path>`. Tests reproduce the exact production pair we observed (`https://www.linkedin.com/in/luke-gaeta-636244375/` ↔ `http://www.linkedin.com/in/luke-gaeta-636244375`).

---

## Apollo fuzzy-matches by name when URL misses; reject those as no-match

**Gotcha:** When the exact LinkedIn URL you sent isn't in Apollo's database, Apollo may return a DIFFERENT person with a similar name/company. Example: we sent `/in/michaeldmyers`, Apollo returned `/in/mike-myers-308010186`. If you correlate by URL, these correctly become no-match (safeguard working). If you correlate loosely, you'd write the wrong person's email to your contact.

**Rule:** Correlation is by normalized URL only. Name-based fuzzy-matches don't correlate — treat as no-match. Log it so you can audit later.

---

## GojiBerry `campaignStatus` is an array of event objects, not a string

**Gotcha:** The field comes back as `[{type, state, createdAt, stepNumber}, ...]`. A `TypeScript as string | null` cast compiles fine but serializes to `"[object Object]"` when JSON-stringified. Found 43 contacts with corrupted data before catching this.

**Fix:** Define a `CampaignEvent` type, normalize on read with `normalizeCampaignStatus(raw)` that validates shape + drops malformed entries.

---

## GojiBerry REST API lacks list-membership endpoints

**Gotcha:** You cannot add a contact to a list via `PATCH /v1/contact/:id` with `listId`, `POST /v1/list/:id/contact(s)`, or any of six other variants we probed. All return 400 or 404. List membership appears to be a MCP-only operation or UI-only.

**Practical impact:** Automation can create contacts and enrich them, but enrollment in a campaign list happens via UI or MCP. Plan around this — don't bake automatic list-enrollment into the daily scan.

---

## Paginated fetches need a named page cap + console.warn on hit

**Pattern:** `fetchAllGojiberry()` caps at `MAX_PAGES=100`. If the cap is hit, `console.warn` so silent truncation is visible. Previously hard-coded `if (page > 100) break` was a latent bug at 10k+ contact scale — master would silently lose records.

```ts
if (page > MAX_PAGES) {
  console.warn(`Hit MAX_PAGES=${MAX_PAGES} cap (~${MAX_PAGES * PAGE_SIZE} contacts). Master may be incomplete.`);
  break;
}
```

---

## Master-file-as-dedup-source beats API-search dedup

**Pattern:** Dedup checks against `data/contacts.jsonl` (master store) instead of `GET /v1/contact?search=<url>` (GojiBerry substring search). Reasons:
1. Zero API calls in the hot path.
2. No dependency on GojiBerry's search semantics (substring matching misses when stored URL format differs from scanned URL format).
3. Testable without mocking the API — pass `_existingUrls: new Set([...])` directly.

**Prerequisite:** Caller must refresh master before scanning (`daily-lead-scan.ts` calls `rebuildMaster()` as step 0). AuthError from rebuild aborts; non-auth errors warn-and-continue (rather-stale-than-stopped).
