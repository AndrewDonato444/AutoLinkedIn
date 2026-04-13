import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GojiBerryClient } from '../../src/api/gojiberry-client.js';
import {
  AuthError,
  ConfigError,
  NotFoundError,
  ServerError,
  TimeoutError,
  ValidationError,
} from '../../src/api/errors.js';
import type { Lead, Campaign, List, ListWithLeads, PaginatedLeads } from '../../src/api/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const TEST_API_KEY = 'test-key-abc123';
const BASE_URL = 'https://ext.gojiberry.ai';

function makeClient(overrides: { rateLimit?: number; timeoutMs?: number } = {}) {
  return new GojiBerryClient({
    apiKey: TEST_API_KEY,
    baseUrl: BASE_URL,
    rateLimit: overrides.rateLimit ?? 10_000, // very high so tests don't throttle
    timeoutMs: overrides.timeoutMs ?? 5_000,
  });
}

type MockResponseInit = {
  status?: number;
  ok?: boolean;
  json?: unknown;
};

function stubFetch(init: MockResponseInit = {}) {
  const status = init.status ?? 200;
  const ok = init.ok ?? status < 400;
  const mockResponse = {
    ok,
    status,
    statusText: status === 200 ? 'OK' : String(status),
    json: () => Promise.resolve(init.json ?? {}),
  };
  return vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));
}

function stubFetchReject(err: Error) {
  return vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
}

function lastFetchUrl(): string {
  const mockFetch = vi.mocked(globalThis.fetch);
  const calls = mockFetch.mock.calls;
  return calls[calls.length - 1][0] as string;
}

function lastFetchCall() {
  const mockFetch = vi.mocked(globalThis.fetch);
  const calls = mockFetch.mock.calls;
  return calls[calls.length - 1];
}

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

const LEAD: Lead = {
  id: 'abc-123',
  firstName: 'Alice',
  lastName: 'Smith',
  profileUrl: 'https://linkedin.com/in/alice',
};

const CAMPAIGN: Campaign = {
  id: 'camp-456',
  name: 'Q2 Outreach',
  status: 'active',
  metrics: { sent: 100, opened: 40, replied: 10, converted: 2 },
};

const LIST: List = { id: 'list-789', name: 'ICP Batch 1', leadCount: 30 };

const LIST_WITH_LEADS: ListWithLeads = {
  ...LIST,
  leads: [LEAD],
};

const PAGINATED_LEADS: PaginatedLeads = {
  leads: [LEAD],
  total: 1,
  page: 1,
  pageSize: 20,
};

// ──────────────────────────────────────────────────────────────────────────────
// Authentication
// ──────────────────────────────────────────────────────────────────────────────

describe('Authentication', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads bearer token from config and sends it in Authorization header', async () => {
    stubFetch({ json: true });
    const client = makeClient();
    await client.healthCheck();

    const [, init] = lastFetchCall();
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TEST_API_KEY}`);
  });

  it('throws ConfigError when GOJIBERRY_API_KEY is missing', () => {
    const saved = process.env.GOJIBERRY_API_KEY;
    delete process.env.GOJIBERRY_API_KEY;

    expect(
      () => new GojiBerryClient({ baseUrl: BASE_URL }),
    ).toThrow(ConfigError);

    if (saved !== undefined) process.env.GOJIBERRY_API_KEY = saved;
  });

  it('ConfigError message instructs user to check .env.local', () => {
    const saved = process.env.GOJIBERRY_API_KEY;
    delete process.env.GOJIBERRY_API_KEY;

    expect(
      () => new GojiBerryClient({ baseUrl: BASE_URL }),
    ).toThrow('Missing GOJIBERRY_API_KEY in .env.local');

    if (saved !== undefined) process.env.GOJIBERRY_API_KEY = saved;
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Health Check
// ──────────────────────────────────────────────────────────────────────────────

describe('healthCheck()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls GET /health', async () => {
    stubFetch({ json: {} });
    const client = makeClient();
    await client.healthCheck();
    expect(lastFetchUrl()).toBe(`${BASE_URL}/health`);
  });

  it('returns true and logs "Connected to GojiBerry" on success', async () => {
    stubFetch({ json: {} });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = makeClient();

    const result = await client.healthCheck();

    expect(result).toBe(true);
    expect(logSpy).toHaveBeenCalledWith('Connected to GojiBerry');
  });

  it('returns false and logs error message on failure', async () => {
    stubFetchReject(new Error('Network error'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient();

    const result = await client.healthCheck();

    expect(result).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(
      'Cannot reach GojiBerry API — check your internet and API key',
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// createLead()
// ──────────────────────────────────────────────────────────────────────────────

describe('createLead()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends POST /v1/contact with minimal fields and returns created lead', async () => {
    stubFetch({ json: LEAD });
    const client = makeClient();

    const result = await client.createLead({
      firstName: 'Alice',
      lastName: 'Smith',
      profileUrl: 'https://linkedin.com/in/alice',
    });

    expect(lastFetchUrl()).toBe(`${BASE_URL}/v1/contact`);
    const [, init] = lastFetchCall();
    expect((init as RequestInit).method).toBe('POST');
    expect(result.id).toBe(LEAD.id);
  });

  it('logs "Lead created: {firstName} {lastName}" on success', async () => {
    stubFetch({ json: LEAD });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = makeClient();

    await client.createLead({
      firstName: 'Alice',
      lastName: 'Smith',
      profileUrl: 'https://linkedin.com/in/alice',
    });

    expect(logSpy).toHaveBeenCalledWith('Lead created: Alice Smith');
  });

  it('sends all fields when a full profile is provided', async () => {
    const fullLead = {
      firstName: 'Bob',
      lastName: 'Jones',
      profileUrl: 'https://linkedin.com/in/bob',
      email: 'bob@example.com',
      company: 'Acme',
      jobTitle: 'CTO',
      location: 'Austin, TX',
      fitScore: 85,
    };
    stubFetch({ json: { ...fullLead, id: 'new-id' } });
    const client = makeClient();

    await client.createLead(fullLead);

    const [, init] = lastFetchCall();
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.email).toBe('bob@example.com');
    expect(body.fitScore).toBe(85);
  });

  it('throws ValidationError and makes no fetch call when profileUrl is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();

    await expect(
      client.createLead({ firstName: 'Alice', lastName: 'Smith', profileUrl: '' }),
    ).rejects.toThrow(ValidationError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ValidationError message specifies required fields', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const client = makeClient();

    await expect(
      client.createLead({ firstName: 'Alice', lastName: 'Smith', profileUrl: '' }),
    ).rejects.toThrow('Lead requires firstName, lastName, and profileUrl');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getLead()
// ──────────────────────────────────────────────────────────────────────────────

describe('getLead()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls GET /v1/contact/{id} and returns lead details', async () => {
    stubFetch({ json: LEAD });
    const client = makeClient();

    const result = await client.getLead('abc-123');

    expect(lastFetchUrl()).toBe(`${BASE_URL}/v1/contact/abc-123`);
    expect(result.id).toBe('abc-123');
  });

  it('throws NotFoundError and logs message when lead does not exist', async () => {
    stubFetch({ status: 404, ok: false, json: {} });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = makeClient();

    await expect(client.getLead('missing-id')).rejects.toThrow(NotFoundError);
    expect(logSpy).toHaveBeenCalledWith('Lead missing-id not found in GojiBerry');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// searchLeads()
// ──────────────────────────────────────────────────────────────────────────────

describe('searchLeads()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls GET /v1/contact with no params when no filters given', async () => {
    stubFetch({ json: PAGINATED_LEADS });
    const client = makeClient();

    await client.searchLeads();

    expect(lastFetchUrl()).toBe(`${BASE_URL}/v1/contact`);
  });

  it('builds query params from filters', async () => {
    stubFetch({ json: PAGINATED_LEADS });
    const client = makeClient();

    await client.searchLeads({
      search: 'alice',
      dateFrom: '2024-01-01',
      intentType: 'hot',
    });

    const url = lastFetchUrl();
    expect(url).toContain('search=alice');
    expect(url).toContain('dateFrom=2024-01-01');
    expect(url).toContain('intentType=hot');
  });

  it('calls GET /v1/contact?scoreFrom=70&scoreTo=100 for score range filter', async () => {
    stubFetch({ json: PAGINATED_LEADS });
    const client = makeClient();

    await client.searchLeads({ scoreFrom: 70, scoreTo: 100 });

    const url = lastFetchUrl();
    expect(url).toContain('scoreFrom=70');
    expect(url).toContain('scoreTo=100');
  });

  it('returns paginated leads with pagination info', async () => {
    stubFetch({ json: PAGINATED_LEADS });
    const client = makeClient();

    const result = await client.searchLeads();

    expect(result.leads).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.page).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// updateLead()
// ──────────────────────────────────────────────────────────────────────────────

describe('updateLead()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends PATCH /v1/contact/{id} and returns updated lead', async () => {
    const updated: Lead = { ...LEAD, fitScore: 90 };
    stubFetch({ json: updated });
    const client = makeClient();

    const result = await client.updateLead('abc-123', {
      fitScore: 90,
      intentSignals: ['visited pricing'],
    });

    expect(lastFetchUrl()).toBe(`${BASE_URL}/v1/contact/abc-123`);
    const [, init] = lastFetchCall();
    expect((init as RequestInit).method).toBe('PATCH');
    expect(result.fitScore).toBe(90);
  });

  it('logs "Lead updated: {firstName} {lastName}" on success', async () => {
    stubFetch({ json: LEAD });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = makeClient();

    await client.updateLead('abc-123', { fitScore: 75 });

    expect(logSpy).toHaveBeenCalledWith('Lead updated: Alice Smith');
  });

  it('throws NotFoundError and logs when lead does not exist', async () => {
    stubFetch({ status: 404, ok: false, json: {} });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = makeClient();

    await expect(client.updateLead('ghost-id', { fitScore: 50 })).rejects.toThrow(NotFoundError);
    expect(logSpy).toHaveBeenCalledWith('Lead ghost-id not found in GojiBerry');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getIntentTypeCounts()
// ──────────────────────────────────────────────────────────────────────────────

describe('getIntentTypeCounts()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls GET /v1/contact/intent-type-counts and returns counts map', async () => {
    const counts = { hot: 12, warm: 34, cold: 7 };
    stubFetch({ json: counts });
    const client = makeClient();

    const result = await client.getIntentTypeCounts();

    expect(lastFetchUrl()).toBe(`${BASE_URL}/v1/contact/intent-type-counts`);
    expect(result['hot']).toBe(12);
    expect(result['warm']).toBe(34);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getCampaigns()
// ──────────────────────────────────────────────────────────────────────────────

describe('getCampaigns()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls GET /v1/campaign and returns all campaigns', async () => {
    stubFetch({ json: [CAMPAIGN] });
    const client = makeClient();

    const result = await client.getCampaigns();

    expect(lastFetchUrl()).toBe(`${BASE_URL}/v1/campaign`);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('camp-456');
  });

  it('calls GET /v1/campaign?activeOnly=true when activeOnly flag is set', async () => {
    stubFetch({ json: [CAMPAIGN] });
    const client = makeClient();

    await client.getCampaigns({ activeOnly: true });

    expect(lastFetchUrl()).toBe(`${BASE_URL}/v1/campaign?activeOnly=true`);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getCampaign()
// ──────────────────────────────────────────────────────────────────────────────

describe('getCampaign()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls GET /v1/campaign/{id} and returns full campaign details', async () => {
    stubFetch({ json: CAMPAIGN });
    const client = makeClient();

    const result = await client.getCampaign('camp-456');

    expect(lastFetchUrl()).toBe(`${BASE_URL}/v1/campaign/camp-456`);
    expect(result.metrics?.sent).toBe(100);
  });

  it('throws NotFoundError and logs when campaign does not exist', async () => {
    stubFetch({ status: 404, ok: false, json: {} });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = makeClient();

    await expect(client.getCampaign('ghost-camp')).rejects.toThrow(NotFoundError);
    expect(logSpy).toHaveBeenCalledWith('Campaign ghost-camp not found in GojiBerry');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getLists()
// ──────────────────────────────────────────────────────────────────────────────

describe('getLists()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls GET /v1/list and returns all lists with lead counts', async () => {
    stubFetch({ json: [LIST] });
    const client = makeClient();

    const result = await client.getLists();

    expect(lastFetchUrl()).toBe(`${BASE_URL}/v1/list`);
    expect(result[0].leadCount).toBe(30);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// getList()
// ──────────────────────────────────────────────────────────────────────────────

describe('getList()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls GET /v1/list/{id} and returns list with its leads', async () => {
    stubFetch({ json: LIST_WITH_LEADS });
    const client = makeClient();

    const result = await client.getList('list-789');

    expect(lastFetchUrl()).toBe(`${BASE_URL}/v1/list/list-789`);
    expect(result.leads).toHaveLength(1);
  });

  it('throws NotFoundError and logs when list does not exist', async () => {
    stubFetch({ status: 404, ok: false, json: {} });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = makeClient();

    await expect(client.getList('ghost-list')).rejects.toThrow(NotFoundError);
    expect(logSpy).toHaveBeenCalledWith('List ghost-list not found in GojiBerry');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Error Handling
// ──────────────────────────────────────────────────────────────────────────────

describe('Error handling: auth failure (401)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws AuthError on 401 response', async () => {
    stubFetch({ status: 401, ok: false });
    const client = makeClient();

    await expect(client.getLists()).rejects.toThrow(AuthError);
  });

  it('AuthError message guides user to check API key', async () => {
    stubFetch({ status: 401, ok: false });
    const client = makeClient();

    await expect(client.getLists()).rejects.toThrow(
      'GojiBerry API key is invalid or expired — check GOJIBERRY_API_KEY in .env.local',
    );
  });

  it('does not retry on 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();

    await expect(client.getLists()).rejects.toThrow(AuthError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Error handling: server errors (5xx)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries up to 3 times on 503 response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([]) });
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();

    const promise = client.getLists();
    // Advance through exponential backoff delays: 1s, 2s, 4s
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result).toBeDefined();
  });

  it('throws ServerError after all retries are exhausted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();

    const promise = client.getLists();
    // Attach assertion before advancing so the rejection is never unhandled
    const assertion = expect(promise).rejects.toThrow(ServerError);
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 100);
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 original + 3 retries
  });

  it('ServerError message guides user to retry later', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.resolve({}),
    }));
    const client = makeClient();

    const promise = client.getLists();
    const assertion = expect(promise).rejects.toThrow('GojiBerry API is down — try again in a few minutes');
    await vi.advanceTimersByTimeAsync(7100);
    await assertion;
  });
});

describe('Error handling: network timeout', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws TimeoutError when fetch aborts', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    stubFetchReject(abortErr);
    const client = makeClient();

    await expect(client.getLists()).rejects.toThrow(TimeoutError);
  });

  it('TimeoutError message advises retry', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    stubFetchReject(abortErr);
    const client = makeClient();

    await expect(client.getLists()).rejects.toThrow(
      'Request timed out — GojiBerry may be slow, try again',
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Rate Limiting
// ──────────────────────────────────────────────────────────────────────────────

describe('Rate limiting', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits when rate limit is hit and logs the wait message', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    vi.stubGlobal('fetch', fetchMock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Rate limit of 2 requests per minute
    const client = makeClient({ rateLimit: 2 });

    // Make 2 requests to fill the window
    await client.getLists();
    await client.getLists();

    // Third request should block, advance past the 60s window
    const promise = client.getLists();
    await vi.advanceTimersByTimeAsync(60_001);
    await promise;

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/Rate limit hit — waiting \d+s before retrying/));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('processes batch requests without throwing rate limit errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    vi.stubGlobal('fetch', fetchMock);

    // Low rate limit to verify pacing kicks in during batch
    const client = makeClient({ rateLimit: 5 });

    // Issue 10 requests (2 windows worth)
    const promises = Array.from({ length: 10 }, () => client.getLists());
    // Advance enough time for both windows
    await vi.advanceTimersByTimeAsync(120_001);
    const results = await Promise.all(promises);

    expect(results).toHaveLength(10);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});
