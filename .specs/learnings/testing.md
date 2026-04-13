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
