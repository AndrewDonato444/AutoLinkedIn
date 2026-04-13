---
name: Testing Patterns
description: Cross-cutting testing patterns, gotchas, and conventions discovered across the codebase
type: feedback
---

# Testing Patterns

## Vitest over Jest for TypeScript projects

Use Vitest instead of Jest for TypeScript-native test running. No extra transpile config (`ts-jest`, `babel-jest`) needed — Vitest handles TypeScript natively.

**Also set in `tsconfig.json`:**
```json
{ "compilerOptions": { "moduleResolution": "bundler" } }
```
This avoids requiring `.js` extensions on TypeScript imports, which is the most common TypeScript ESM friction point.

---

## Fake timers + async rejections: attach assertion BEFORE advancing time

**Problem:** `PromiseRejectionHandledWarning` fires when a rejection occurs before `.rejects` attaches.

**Wrong:**
```ts
const promise = client.doThing(); // rejects immediately when timer fires
vi.advanceTimersByTime(30_001);
await expect(promise).rejects.toThrow(TimeoutError); // handler attached too late
```

**Right — assign the assertion first, then advance timers:**
```ts
const promise = client.doThing();
const assertion = expect(promise).rejects.toThrow(TimeoutError); // handler registered sync
vi.advanceTimersByTime(30_001);
await assertion;
```

This ensures the rejection handler is registered synchronously before fake timers fire, preventing the unhandled rejection gap.

---

## Rate-limiter batch tests need enough time for multiple windows

When testing that a rate limiter processes N requests across multiple windows, advance by enough milliseconds for all windows to expire — not just one.

**Example:** 10 requests at a limit of 5/min (60s window):
- Window 1: requests 1–5 (0ms)
- Window 2: requests 6–10 (after 60s reset)
- Advance by **120001ms** (not 60001ms) to cover both windows with buffer.

---

## Mock AbortError by name, not by timer

For testing request timeout behavior, mock the error directly instead of trying to simulate a real 30s timeout via `vi.advanceTimersByTime`. The `AbortController` throws an `Error` with `name === 'AbortError'` — mock that shape:

```ts
vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
```

This is simpler and more reliable than coordinating fake timers with the `setTimeout` → `controller.abort()` chain.

---

## Spy on console for log assertions

Use `vi.spyOn(console, 'log')` and `vi.spyOn(console, 'error')` to assert logging behavior. Restore in `afterEach`. This avoids noisy test output while still verifying the log messages that matter to the user experience.

---

## Manipulate `process.env` directly for config tests

For testing constructor behavior when env vars are missing or present:
```ts
const originalKey = process.env.GOJIBERRY_API_KEY;
delete process.env.GOJIBERRY_API_KEY;
// ... test throws ConfigError ...
process.env.GOJIBERRY_API_KEY = originalKey;
```
No special env-mocking library needed. Restore in `afterEach` or in a `finally` block.

---

## Inject typed functions (not SDK objects) to avoid mocking constructors

When testing code that calls an SDK (e.g., Anthropic), injecting a typed function is cleaner than mocking the SDK object:

```ts
// In source:
type WebSearchFn = (query: string) => Promise<DiscoveredLead[]>;
async function discoverLeads(options?: { _webSearch?: WebSearchFn }) {
  const webSearch = options._webSearch ?? defaultWebSearch; // defaultWebSearch uses real SDK
}

// In test:
const mockSearch = vi.fn().mockResolvedValue([{ firstName: 'Jane', ... }]);
await discoverLeads({ _webSearch: mockSearch });
```

No SDK constructor mocking, no method chain stubbing. The `_` prefix signals "internal/test-only" contract. Real implementation (`defaultWebSearch`) is tested separately or via integration tests.

---

## Use `Pick<>` for minimal mock client interfaces

When a function only uses a subset of a client's methods, narrow the type:

```ts
type LeadClient = Pick<GojiBerryClient, 'createLead' | 'searchLeads'>;
```

Test mocks only need to implement the two methods actually called — not the full 15-method interface. This also makes it obvious at a glance which methods the function depends on.

---

## Apostrophe in `describe()` string breaks esbuild — use double-quotes

A single-quote inside a `describe()` string literal breaks esbuild's string parser with a cryptic parse error. Switch to double-quotes for any describe block whose label contains an apostrophe:

```ts
// Wrong — esbuild parse error
describe('Scenario: Research a lead's online activity', () => { ... });

// Right
describe("Scenario: Research a lead's online activity", () => { ... });
```

This applies to any string that esbuild processes (describe, it, test labels). The fix is purely cosmetic — use double-quotes whenever the label contains a possessive.

---

## Stateful mocks with call counters for "fails on Nth call" tests

When testing that a batch continues after one item fails, use a closure counter rather than chaining many `.mockResolvedValueOnce()` calls:

```ts
let updateCallCount = 0;
const mockUpdate = vi.fn().mockImplementation(async (id, data) => {
  updateCallCount++;
  if (updateCallCount === 6) throw new Error('Network error');
  return { id, ...data };
});
```

Cleaner than `mockResolvedValueOnce` × 5 then `mockRejectedValueOnce`. Also works for "every other call fails" or "fails after N calls" patterns.

---

## TypeScript union type narrowing: don't remove "redundant" re-checks after `.find()`

After `.find((b) => b.type === 'text')`, TypeScript still types the result as the full union. A second guard `if (block.type !== 'text') return;` looks logically redundant but is required for TypeScript to narrow the type against SDK union definitions:

```ts
const textBlock = response.content.find((b) => b.type === 'text');
if (!textBlock) return;
if (textBlock.type !== 'text') return; // looks redundant — DO NOT remove
// TypeScript now knows textBlock is TextBlock, not ContentBlock union
console.log(textBlock.text);
```

This pattern is load-bearing. Removing the second guard breaks compilation even though the runtime behavior is identical.

---

## Choose mock totals so approximated counts work out arithmetically

When testing a feature that approximates a count (`remaining = page.total - page.leads.length`), choose mock `total` values such that the arithmetic produces exactly the expected result. Don't use production-realistic numbers if they produce wrong test assertions:

```ts
// Spec says: "15 enriched, 15 remaining" with batchSize=15
// Wrong: total=40 → 40-15=25 remaining (test fails)
// Right: total=30 → 30-15=15 remaining ✓
mockSearchLeads.mockResolvedValue({ leads: [...15 leads...], total: 30 });
```

Always verify: `mockTotal - batchSize === expectedRemaining` before writing the assertion.

---

## Mock client factory with `Partial<override map>` + `asClient()` cast helper

When mocking a client for multiple tests, create a factory that accepts overrides and a cast helper that avoids repeating `as unknown as ClientType`:

```ts
type MockClient = { searchLeads: ReturnType<typeof vi.fn>; ... };

function makeMockClient(overrides: Partial<{
  searchLeads: () => Promise<PaginatedLeads>;
  getCampaigns: () => Promise<Campaign[]>;
  // ...
}> = {}): MockClient {
  return {
    searchLeads: overrides.searchLeads
      ? vi.fn().mockImplementation(overrides.searchLeads)
      : vi.fn().mockResolvedValue(paginatedWith([])),
    // ...
  };
}

function asClient(mock: MockClient): GojiBerryClient {
  return mock as unknown as GojiBerryClient;
}
```

The `Partial<{ method: () => Promise<T> }>` override shape means each test only specifies what it needs. `asClient()` removes the noisy cast from every test call site — keeps test bodies readable.

---

## `Pick<>` on the function signature eliminates mock cast entirely

When the source function accepts `Pick<ClientType, 'method'>` instead of the full `ClientType`, a mock object that only implements those methods satisfies the type structurally — no `as unknown as ClientType` cast anywhere:

```ts
// Source:
type AnalyticsClient = Pick<GojiBerryClient, 'getCampaigns'>;
export async function analyzeCampaignPerformance(options?: {
  _client?: AnalyticsClient; // ← Pick, not GojiBerryClient
}): Promise<CampaignReport> { ... }

// Test — no cast needed:
const client = { getCampaigns: vi.fn().mockResolvedValue([...]) };
await analyzeCampaignPerformance({ _client: client }); // ✓ compiles
```

Use `Pick<>` on the function parameter type (not just on the mock type) whenever you want truly cast-free injection. Extend to full `GojiBerryClient` only when the function calls many methods and the cast is less painful than the type.

---

## Env-dependent defaults: use floor assertions not exact values

When a function reads a numeric config from `process.env` (e.g., `MIN_INTENT_SCORE`), tests can't know whether `.env.local` overrides the default or not. A `toBe(50)` assertion breaks whenever the env file sets it to 60. Use a floor assertion instead:

```ts
// Fragile — breaks when .env.local sets MIN_INTENT_SCORE=60
expect(result.filters.scoreFrom).toBe(50);

// Resilient — passes for any valid override >= 50
expect(callArgs.scoreFrom).toBeGreaterThanOrEqual(50);
```

Add an inline comment explaining the two possible values so future readers understand the range assertion isn't laziness. Apply this to any config value that can legitimately differ between environments.

---

## Separate `makeMockClientThrowing` factory for error-path tests

Alongside the standard `makeMockClient(pages)` factory, add a distinct factory for error-path tests:

```ts
function makeMockClientThrowing(error: Error): MockClient {
  return { searchLeads: vi.fn().mockRejectedValue(error) };
}
```

Avoids repeating `.mockRejectedValue(error)` inline at every error test call site. The naming convention makes it immediately obvious which factory is for the failure path vs. the success path.

---

## Choose test parameter values that can't mask bugs

A duplicate-detection test with `limit=4` and exactly 4 leads will pass whether or not duplicates consume limit slots — because 4 leads processed = 4 leads processed either way. Choose values where the behavior under test produces a *different observable result* than the alternative. E.g., use `limit=3` with 4 leads where 1 is a duplicate: if duplicates consume slots, 2 leads get created; if they don't, 3 do.

---

## Real temp dirs via `os.mkdtempSync` for filesystem injection tests

When a function accepts a `_snapshotDir` (or similar path injection point), test it with a real temp directory rather than mocking `fs`. This avoids the complexity of mocking `fs.readdirSync`, `fs.readFileSync`, `fs.writeFileSync`, etc., and tests actual filesystem behavior:

```ts
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpDir = os.mkdtempSync(path.join(os.tmpdir(), 'test-snapshots-'));
// use tmpDir as _snapshotDir in the call under test
// optionally clean up: fs.rmSync(tmpDir, { recursive: true })
```

When `_snapshotDir` points to a fresh (empty) temp dir, `readdirSync` returns `[]` — which correctly triggers "no previous snapshot" paths without any explicit setup. To simulate "a previous week exists", write a fixture file into the tmpDir before calling the function:

```ts
const yesterdayPath = path.join(tmpDir, '2026-04-06.json');
fs.writeFileSync(yesterdayPath, JSON.stringify(previousSnapshot));
```

This pattern pairs with `Pick<>` client injection (also documented here) — both use the `_` prefix convention to signal "internal/test-only" parameters.
