# Learnings Index

Cross-cutting patterns extracted from implementation sessions. Read the linked files for full details.

## Files

- [Testing Patterns](testing.md) — Vitest setup, fake-timer gotchas, AbortError mocking, spy on console, function injection, Pick<> for mocks, real temp dirs for filesystem injection
- [API & Data Patterns](api.md) — HTTP client design, two-tier 404 errors, rate limiting, env config, retry backoff, SDK type casting, LLM-delegated ranking, ISO date filenames
- [General Patterns](general.md) — Thin orchestration layers, named threshold constants, date math edge cases, spec output template drift

## Recent Learnings (2026-04-13)

**Daily Lead Scan Automation** — the most hard-won lessons from this session:

1. **Full-function injection for orchestrators** (general.md): Inject `_discoverLeads`, `_enrichLeads`, `_generateMessages` — not sub-dependencies. Keeps the orchestrator as a pure coordinator; three mocks cover 40 tests.

2. **`abort()` closure for repeated async abort paths** (general.md): 4 hard-stop paths each needed build+save+return. Inner closure capturing shared state cut 60 lines (481→442). Only applies when abort paths differ only in string arguments.

3. **Destructure-to-exclude for log serialization** (general.md): `{ summaryText: _summaryText, ...logData }` strips human-readable field before writing JSON without mutation.

4. **Aspirational spec clauses for delegated concerns** (general.md): "The summary notes if rate limiting caused delays" was never implementable — the underlying client exposes no timing metadata. Remove such clauses during drift check; don't add stub code to satisfy aspirational spec text.

5. **`Parameters<typeof fn>[0]` for pass-through options typing** (testing.md): Derives the type from the sibling function's signature without importing or duplicating its interface.

6. **String assertions must match exact output format** (testing.md): Test expected `'5 enriched'`, actual was `'5 leads enriched, 3 failed'`. Always verify the exact prose string against the source before writing the assertion.

---

## Recent Learnings (2026-04-13)

**Personalized Message Generation** — the most hard-won lessons from this session:

1. **`remaining` from filtered eligibles, not `page.total`** (api.md): When client-side filtering after a large fetch, `remaining = eligible.length - batchSize`. Using `page.total` inflates the count with already-messaged and signal-less leads, misleading the user about how many runs are left.

2. **Force-refresh flag must appear in EVERY filter pass** (general.md): When a batch has both a "skip already processed" partition AND an eligibility filter, `forceRegenerate` must be threaded through each independently. Missing it from the partition pass yields a wrong `skipped` count even when the eligible filter is correct.

3. **Sentence-boundary truncation for LLM character-limited output** (api.md): Truncate at the last period past 50% of the limit — not at `maxLength`. Hard-truncation mid-sentence is jarring; sentence-boundary truncation preserves readability. Also prompt the LLM to respect the limit, but always enforce programmatically.

4. **Tests green on first pass when patterns are reused** (testing.md): Zero friction — `Pick<>` client type, `_messageGenerator` injection, `resolvePositiveNumber` reuse, and `vi.spyOn(console)` for log assertions all carried over cleanly from prior features. Validates these patterns as stable; apply them upfront on the next feature.

5. **Single-responsibility extraction during refactor** (general.md): `defaultMessageGenerator` was ~60 lines combining prompt construction, API call, and length enforcement. Extracting `buildMessagePrompt` and `enforceMaxLength` reduced it to ~20 lines with three clearly separate concerns. When a function has inline string templates AND inline validation logic, those are extraction candidates.

---

## Recent Learnings (2026-04-13)

**Lead Quality Feedback Loop** — the most hard-won lessons from this session:

1. **Sequential-then-parallel fetch for AuthError gate** (api.md): Fetch the auth-gating call first (e.g., `getCampaigns`), then run remaining independent calls in `Promise.all`. Ensures `AuthError` aborts before any downstream work starts. Discovered when `Promise.all([campaigns, leads, intentCounts])` failed the "does not call searchLeads" test.

2. **`arrayContaining` for mixed LLM+deterministic arrays** (testing.md): When one report field is populated by both a deterministic step (field importance) and an LLM step (signal analysis), `toHaveLength(n)` assertions break because total count varies. Use `expect.arrayContaining([expect.objectContaining({...})])` to verify specific entries without constraining total count.

3. **Module-level ID counter for fixture uniqueness** (testing.md): 13 describe blocks with hardcoded lead IDs cause silent test coupling via Set-based de-duplication. Use a module-level `let _leadId = 0` incrementor in the `makeLead()` helper — unique IDs across the whole test file.

4. **Config data-quantity gate vs. fixture size** (testing.md): `minLeads: 30` triggers early-return when a test has only 25 leads — test passes vacuously on empty arrays. Fix: either provide enough fixture data or pass `{ minLeads: 25 }` to match. Applies to any data-quantity gate.

5. **Normalize union accumulator arrays to eliminate always-true guards** (general.md): An `Array<TypeA | TypeB>` accumulator where all elements are `TypeB` forces always-true `'field' in item` guards downstream. Re-declare as `Array<TypeB>` upfront; guards and noise disappear.

---

## Recent Learnings (2026-04-13)

**ICP Refinement from Results** — the most hard-won lessons from this session:

1. **`intentType: 'replied'` as reply-status proxy** (api.md): No per-lead reply-status field exists in `LeadFilters`. Use `intentType: 'replied'` as a proxy filter + Set-diff against all leads to derive the non-replied segment. Run both `searchLeads` calls in `Promise.all`.

2. **Enforce confidence rules post-LLM, not inside the LLM** (general.md): After the LLM returns trait classifications, apply a deterministic `applyConfidenceRules` step in the automation. Traits with `sampleSize < MIN_SAMPLE_FOR_HIGH_CONFIDENCE` get reclassified 'working' → 'watch' regardless of what the LLM said. Keeps confidence enforcement a testable pure function.

3. **Gate `proposedIcp` to `null` when no high-confidence suggestions** (general.md): Only expose a proposed ICP when at least one high-confidence suggestion exists. Prevents founders from acting on small-sample noise. Test explicitly: low-confidence-only output → `proposedIcp === null`.

4. **Named factory for duplicate early-return report objects** (general.md): Two early-exit gates (insufficient campaigns, zero replies) returned 9-field objects sharing 8 of 9 fields. Extract a `makeInsufficientDataReport(currentIcp, campaignCount, totalSent, message)` factory. Signals the semantic, eliminates the duplication, makes the one varying field explicit.

5. **Spec dependency section drifts when anticipated helper isn't used** (general.md): Spec listed `analyzeCampaignPerformance()` as a dependency; implementation never imported it (direct `c.metrics` access was simpler). The dependency section needs verification in every drift check — check that listed deps appear in the source file's imports.

---

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
