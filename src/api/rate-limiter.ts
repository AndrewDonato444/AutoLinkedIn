const WINDOW_MS = 60_000; // 1 minute

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RateLimiter {
  private timestamps: number[] = [];
  private readonly limit: number;

  constructor(requestsPerMinute = 100) {
    this.limit = requestsPerMinute;
  }

  async throttle(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < WINDOW_MS);

    if (this.timestamps.length >= this.limit) {
      const oldest = this.timestamps[0];
      const waitMs = WINDOW_MS - (now - oldest);
      const waitSeconds = Math.ceil(waitMs / 1000);
      console.log(`Rate limit hit — waiting ${waitSeconds}s before retrying`);
      await sleep(waitMs);
      // Re-prune after waiting
      const nowAfter = Date.now();
      this.timestamps = this.timestamps.filter((t) => nowAfter - t < WINDOW_MS);
    }

    this.timestamps.push(Date.now());
  }

  get requestCount(): number {
    const now = Date.now();
    return this.timestamps.filter((t) => now - t < WINDOW_MS).length;
  }
}
