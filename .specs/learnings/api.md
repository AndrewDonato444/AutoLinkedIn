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

## Don't duplicate `sleep` across files — just inline it

A one-line `sleep` function is so small that creating a shared utility file adds more complexity (import paths, another file to maintain) than it saves. Each file that needs it can define it locally:

```ts
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

Per SDD guidelines: three similar lines is better than a premature abstraction.
