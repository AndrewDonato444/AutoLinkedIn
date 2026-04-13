# Learnings Index

Cross-cutting patterns extracted from implementation sessions. Read the linked files for full details.

## Files

- [Testing Patterns](testing.md) — Vitest setup, fake-timer gotchas, AbortError mocking, spy on console
- [API & Data Patterns](api.md) — HTTP client design, two-tier 404 errors, rate limiting, env config, retry backoff

## Recent Learnings (2026-04-13)

**GojiBerry API Client** — the most hard-won lessons from this session:

1. **Fake timer + async rejection trap** (testing.md): Assign `expect(promise).rejects` to a variable *before* advancing fake timers. If you advance time first, the rejection fires before the handler attaches → `PromiseRejectionHandledWarning`. This is the most surprising failure mode in Vitest async tests.

2. **Two-tier 404 pattern** (api.md): Use an internal `Http404Error` in the base `request()` and a public `NotFoundError` in resource methods. Consolidate GET-by-ID with a `getById<T>` helper. PATCH methods with post-success logging need their own inline handler.

3. **Library throws, CLI exits** (api.md): Specs written aspirationally may say "exits" — correct to "throws" when the code is a library. `process.exit()` is untestable and non-reusable.

4. **`process.cwd()` for `.env.local`** (api.md): Use `path.join(process.cwd(), '.env.local')` not `__dirname` — scripts run from the project root, not from the compiled file's directory.

5. **Vitest + `"moduleResolution": "bundler"`** (testing.md): The fastest path to TypeScript testing with no extra config. No `ts-jest`, no Babel, no `.js` extensions on imports.
