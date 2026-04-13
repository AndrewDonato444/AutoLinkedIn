# Learnings Index

Cross-cutting patterns extracted from implementation sessions. Read the linked files for full details.

## Files

- [Testing Patterns](testing.md) — Vitest setup, fake-timer gotchas, AbortError mocking, spy on console, function injection, Pick<> for mocks
- [API & Data Patterns](api.md) — HTTP client design, two-tier 404 errors, rate limiting, env config, retry backoff, SDK type casting, LLM-delegated ranking

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
