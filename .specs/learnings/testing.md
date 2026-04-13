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

## Choose test parameter values that can't mask bugs

A duplicate-detection test with `limit=4` and exactly 4 leads will pass whether or not duplicates consume limit slots — because 4 leads processed = 4 leads processed either way. Choose values where the behavior under test produces a *different observable result* than the alternative. E.g., use `limit=3` with 4 leads where 1 is a duplicate: if duplicates consume slots, 2 leads get created; if they don't, 3 do.
