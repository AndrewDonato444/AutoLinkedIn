# Learnings Index

Cross-cutting patterns extracted from implementation sessions. Read the linked files for full details.

## Files

- [Testing Patterns](testing.md) — Vitest setup, fake-timer gotchas, AbortError mocking, spy on console, function injection, Pick<> for mocks
- [API & Data Patterns](api.md) — HTTP client design, two-tier 404 errors, rate limiting, env config, retry backoff, SDK type casting, LLM-delegated ranking

## Recent Learnings (2026-04-13)

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
