# Learnings Index

Cross-cutting patterns extracted from implementation sessions. Read the linked files for full details.

## Files

- [Testing Patterns](testing.md) — Vitest setup, fake-timer gotchas, AbortError mocking, spy on console, function injection, Pick<> for mocks, real temp dirs for filesystem injection
- [API & Data Patterns](api.md) — HTTP client design, two-tier 404 errors, rate limiting, env config, retry backoff, SDK type casting, LLM-delegated ranking, ISO date filenames
- [General Patterns](general.md) — Thin orchestration layers, named threshold constants, date math edge cases, spec output template drift

## Recent Learnings (2026-04-13)

**Campaign Health Monitor** — the most hard-won lessons from this session:

1. **Separate `recoveries` array from `alerts`** (general.md): Recovery signals belong in a dedicated `recoveries: CampaignAlert[]` field on the report interface — not mixed into `alerts`. Callers can then distinguish "new problem" from "resolved problem" without inspecting `alert.type`.

2. **`status` field and display format can intentionally differ** (general.md): `status = "too early to evaluate — 3/10 sends"` (machine-readable) vs. display `"too early (3/10 sends)"` (abbreviated output). Document both in the spec's Output Format and Function Signature; the drift check flags them if only one is updated.

3. **File-write absence as early-exit signal** (testing.md): To verify an AuthError aborts before any side effects, assert `fs.readdirSync(tmpDir).length === 0` after the throw — not just that the error was thrown. Cleaner than asserting on call counts or partial state.

4. **`daysAgoIso(n)` helper for stall tests** (testing.md): Hard-coded ISO timestamps make stall detection tests brittle as dates advance. Use a `daysAgoIso(n)` helper that computes relative to `new Date()`.

5. **Gherkin prose can describe types that were narrowed during implementation** (spec learnings): The "Store health snapshot" scenario said "last-send timestamps" but `HealthSnapshot` only stores `id, alerts, replyRate, sent` — `lastSendEstimate` is transient. The drift check caught this. Always reconcile scenario text against type definitions during drift check.

---

## Recent Learnings (2026-04-13)

**Morning Briefing** — the most hard-won lessons from this session:

1. **Filter-aware mock implementations for call-argument isolation** (testing.md): When the same mock method is called with different filter args (e.g., once without `scoreFrom`, once with it), the mock must apply those filters. A naive "return everything" mock makes "no warm leads" and "has warm leads" scenarios impossible to isolate without separate describe blocks.

2. **Argument-conditional `mockImplementation` for partial failure** (testing.md): Partial failure tests where one call fails and another succeeds are cleanest when the mock inspects the call's arguments rather than a call counter — `if (filters.scoreFrom != null) throw error`. More precise and more readable than counting call order.

3. **Composed builder DTOs may strip needed fields** (spec learnings): `buildWarmLeadList` maps results through `toWarmLead`, dropping `personalizedMessages`. A second `searchLeads` call is required to check message status. Check whether a builder's return type carries every field before assuming one call is enough.

4. **Spec output format section is the ground truth over scenario descriptions** (general.md): When a scenario description and the Output Format template conflict, the template wins — it was written with the actual data model in mind. Reconcile scenario wording to match the format, not the other way around, during drift check.

---

## Recent Learnings (2026-04-13)

**Weekly Performance Report** — the most hard-won lessons from this session:

1. **Real temp dirs for filesystem injection tests** (testing.md): Use `os.mkdtempSync` instead of mocking `fs`. An empty tmpdir correctly triggers "no previous snapshot" paths; write fixture files into it to simulate "previous week exists". Pairs with `_snapshotDir` injection using the same `_` prefix convention as `_client`.

2. **ISO date filenames = free chronological sort** (api.md): `YYYY-MM-DD.json` files sort alphabetically in chronological order. `files.sort().reverse()[0]` gives the most recent — no date parsing needed.

3. **Named constants for ALL thresholds in analytics code** (general.md): Extract every magic number (reply rate floors, dominance factors, stability cutoffs, display caps) to named constants at the top of the file. When the same value appears in two functions, naming it ensures they stay in sync.

4. **"Next Monday" guard: if today is Monday, add 7 not 0** (general.md): `(8 - day) % 7` gives 0 when `day === 1`. Guard with `day === 1 ? 7 : (8 - day) % 7` to avoid "next report: today" on Monday runs.

5. **Thin orchestration over existing analytics** (general.md): Delegate to `analyzeCampaignPerformance()` rather than reimplementing. The value of the weekly report layer is scheduling + WoW comparison + recommendations, not re-doing metrics math.

---

## Recent Learnings (2026-04-13)

**Warm Lead List Builder** — the most hard-won lessons from this session:

1. **`Record<string, unknown>` for optional filter accumulation** (api.md): Build the API filter object by conditionally assigning keys only when present. Keeps `undefined` values out of the request object, which some APIs treat differently from absent keys. Cast to the typed parameter at the call site.

2. **Env-dependent defaults: floor assertions not exact values** (testing.md): When a function reads numeric config from `process.env`, tests can't know if `.env.local` overrides it. Use `toBeGreaterThanOrEqual(minDefault)` instead of `toBe(exactValue)` — add a comment explaining the range.

3. **Separate `makeMockClientThrowing` factory** (testing.md): A dedicated factory for error-path mocks (`makeMockClientThrowing(error)`) keeps tests readable alongside the standard `makeMockClient(pages[])`. Avoids repeating `.mockRejectedValue()` inline at every error call site.

---

## Recent Learnings (2026-04-13)

**Campaign Performance Analytics** — the most hard-won lessons from this session:

1. **Sort for display ≠ sort for analysis** (spec learnings): Always preserve original API order for trend analysis. Passing the reply-rate-sorted array to `computeTrend` makes "latest" always the worst performer, producing a false "declining" signal. Filter `completedCampaigns` from pre-sort `allMetrics`, then pass both arrays separately.

2. **`needsAttention` null when ≤1 with sends**: With exactly one campaign that has sends, it's the top performer — assigning it to `needsAttention` too would surface contradictory labels. Guard with `withSends.length > 1`.

3. **`Pick<>` on function parameter eliminates mock casts** (testing.md): Accepting `Pick<GojiBerryClient, 'getCampaigns'>` instead of the full client means any object implementing only that method satisfies the type. Zero `as unknown as Client` casts needed in tests.

4. **Zero-send campaigns: include in display, exclude from metrics**: Draft campaigns appear in `byStatus` groups as "no data yet" but are excluded from averages, rankings, and trend via a `withSends` filter.

---

## Recent Learnings (2026-04-13)

**Pipeline Overview Report** — the most hard-won lessons from this session:

1. **`Promise.all()` for parallel API fan-out** (api.md): When N endpoints are independent, fetch them in one `Promise.all()` and destructure the tuple. Sequential awaits are N× slower for no benefit.

2. **`do...while` for pagination** (api.md): Always fetches at least one page before checking the termination condition (`allLeads.length < total`). Cleaner than while-with-pre-check, avoids off-by-one on single-page results.

3. **Guard both `undefined` and `null` for optional API fields** (api.md): APIs may return `null` explicitly or omit the field. Check `score === undefined || score === null` — loose equality `== null` works but is ambiguous; a single `=== undefined` check silently misses explicit nulls.

4. **Mock client factory + `asClient()` cast** (testing.md): `makeMockClient(overrides)` accepts a `Partial<{method: () => Promise<T>}>` map; unspecified methods default to empty stubs. A separate `asClient()` helper applies the `as unknown as GojiBerryClient` cast once, keeping test bodies readable.

5. **Pure function aggregation after async fetch**: Split the async fetch phase from synchronous aggregation (`computeScoreTiers`, `aggregateCampaigns`, `generateSummary`). Pure functions on already-fetched data are trivially unit-testable without async machinery.

---



**Lead Enrichment + Intent Scoring** — the most hard-won lessons from this session:

1. **Apostrophe in `describe()` breaks esbuild** (testing.md): Single-quotes inside describe labels cause esbuild parse errors. Use double-quotes for any describe block with a possessive apostrophe.

2. **Stateful mocks with call counters** (testing.md): Use a closure counter to simulate "fails on Nth call" — cleaner than chaining many `.mockResolvedValueOnce()` calls.

3. **TypeScript union type narrowing after `.find()`** (testing.md): A second `if (block.type !== 'text') return;` after `.find()` looks redundant but is required for TypeScript to narrow SDK union types. Never remove it.

4. **Choose mock totals so approximated counts work out** (testing.md): When `remaining = page.total - page.leads.length` is an approximation, verify `mockTotal - batchSize === expectedRemaining` before writing assertions.

5. **Extract `resolvePositiveNumber` for repeated option→env→default pattern** (api.md): When multiple numeric settings follow the same override hierarchy, one named helper handles the `Number("")` guard and keeps the logic DRY.

6. **Auth errors split by loop position — spec each phase** (api.md): Errors before the loop propagate silently; errors inside the loop can be caught and logged. Specs saying "auth fails → outputs message" will diverge from implementation unless each phase is documented separately.

---



**ICP-Based Lead Discovery** — the most hard-won lessons from this session:

1. **Function injection beats SDK mocking** (testing.md): Inject a typed `WebSearchFn` instead of mocking the Anthropic SDK constructor. 33 tests, zero SDK mocking. The `_` prefix marks internal/test-only parameters.

2. **`Number("")` = 0, not NaN** (api.md): Empty string env vars silently produce 0. Coerce to a default with `|| DEFAULT_LIMIT` *before* calling `Number()`, then validate `> 0`.

3. **`as any` for unreleased SDK tools** (api.md): `web_search_20250305` isn't in SDK types yet. Cast `tools` as `any` with an inline comment — cleaner than type gymnastics.

4. **Test parameter values can mask bugs** (testing.md): A duplicate test with `limit=4` and 4 leads passes whether or not duplicates consume slots. Choose values where the behavior under test produces a *different* observable result.

5. **Delegate ranking to the LLM prompt** (api.md): Ask the model to return results "ranked best-first" and just `slice(0, limit)`. No scoring algorithm to implement or test.

6. **Spec post-build drift is inevitable** (general pattern): Spec written pre-implementation diverged on 5 points by the time the drift check ran — status, env vars, duplicate slot semantics, ranking ownership, and public API surface. Plan for a post-build spec reconciliation pass on every feature.

---

**GojiBerry API Client** — the most hard-won lessons from this session:

1. **Fake timer + async rejection trap** (testing.md): Assign `expect(promise).rejects` to a variable *before* advancing fake timers. If you advance time first, the rejection fires before the handler attaches → `PromiseRejectionHandledWarning`. This is the most surprising failure mode in Vitest async tests.

2. **Two-tier 404 pattern** (api.md): Use an internal `Http404Error` in the base `request()` and a public `NotFoundError` in resource methods. Consolidate GET-by-ID with a `getById<T>` helper. PATCH methods with post-success logging need their own inline handler.

3. **Library throws, CLI exits** (api.md): Specs written aspirationally may say "exits" — correct to "throws" when the code is a library. `process.exit()` is untestable and non-reusable.

4. **`process.cwd()` for `.env.local`** (api.md): Use `path.join(process.cwd(), '.env.local')` not `__dirname` — scripts run from the project root, not from the compiled file's directory.

5. **Vitest + `"moduleResolution": "bundler"`** (testing.md): The fastest path to TypeScript testing with no extra config. No `ts-jest`, no Babel, no `.js` extensions on imports.
