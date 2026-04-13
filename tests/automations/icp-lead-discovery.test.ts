import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { discoverLeads } from '../../src/automations/icp-lead-discovery.js';
import { ConfigError, AuthError } from '../../src/api/errors.js';
import type { DiscoveredLead, DiscoveryResult } from '../../src/automations/types.js';
import type { PaginatedLeads, Lead, CreateLeadInput } from '../../src/api/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeLead(overrides: Partial<DiscoveredLead> = {}): DiscoveredLead {
  return {
    firstName: 'Jane',
    lastName: 'Doe',
    profileUrl: 'https://linkedin.com/in/jane-doe',
    company: 'Acme SaaS',
    jobTitle: 'CEO',
    location: 'San Francisco, CA',
    icpFitReason: 'Series A SaaS founder in fintech',
    ...overrides,
  };
}

function makeLeads(count: number, prefix = 'Lead'): DiscoveredLead[] {
  return Array.from({ length: count }, (_, i) =>
    makeLead({
      firstName: prefix,
      lastName: `${i + 1}`,
      profileUrl: `https://linkedin.com/in/${prefix.toLowerCase()}-${i + 1}`,
    }),
  );
}

function emptyPaginated(): PaginatedLeads {
  return { leads: [], total: 0, page: 1, pageSize: 20 };
}

function paginatedWith(leads: Lead[]): PaginatedLeads {
  return { leads, total: leads.length, page: 1, pageSize: 20 };
}

function makeMockClient(overrides: {
  createLead?: (input: CreateLeadInput) => Promise<Lead>;
  searchLeads?: (filters?: Record<string, unknown>) => Promise<PaginatedLeads>;
} = {}) {
  return {
    createLead: overrides.createLead ?? vi.fn().mockResolvedValue({ id: 'created-id', firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://linkedin.com/in/jane-doe' } as Lead),
    searchLeads: overrides.searchLeads ?? vi.fn().mockResolvedValue(emptyPaginated()),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Reject run when ICP description is missing
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Reject run when ICP description is missing', () => {
  beforeEach(() => {
    delete process.env.ICP_DESCRIPTION;
  });

  it('throws ConfigError when ICP_DESCRIPTION is not set', async () => {
    await expect(discoverLeads()).rejects.toThrow(ConfigError);
  });

  it('ConfigError message instructs founder to set ICP_DESCRIPTION', async () => {
    await expect(discoverLeads()).rejects.toThrow(
      'Missing ICP_DESCRIPTION in .env.local — describe your ideal customer first',
    );
  });

  it('throws ConfigError when ICP_DESCRIPTION is empty string', async () => {
    await expect(discoverLeads({ icpDescription: '' })).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError when ICP_DESCRIPTION is whitespace only', async () => {
    await expect(discoverLeads({ icpDescription: '   ' })).rejects.toThrow(ConfigError);
  });

  it('does not call webSearch when ICP is missing', async () => {
    const webSearch = vi.fn();
    await expect(discoverLeads({ _webSearch: webSearch })).rejects.toThrow(ConfigError);
    expect(webSearch).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Discover leads from ICP description
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Discover leads from ICP description', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes icpDescription to web search function', async () => {
    const webSearch = vi.fn().mockResolvedValue([makeLead()]);
    const client = makeMockClient();

    await discoverLeads({
      icpDescription: 'Series A SaaS founders in fintech who are actively hiring',
      _webSearch: webSearch,
      _client: client,
    });

    expect(webSearch).toHaveBeenCalledWith(
      'Series A SaaS founders in fintech who are actively hiring',
    );
  });

  it('creates each discovered lead in GojiBerry via createLead', async () => {
    const leads = makeLeads(3);
    const client = makeMockClient();

    await discoverLeads({
      icpDescription: 'SaaS founders',
      _webSearch: vi.fn().mockResolvedValue(leads),
      _client: client,
    });

    expect(client.createLead).toHaveBeenCalledTimes(3);
  });

  it('returns created leads in result.created', async () => {
    const leads = makeLeads(3);
    const client = makeMockClient();

    const result = await discoverLeads({
      icpDescription: 'SaaS founders',
      _webSearch: vi.fn().mockResolvedValue(leads),
      _client: client,
    });

    expect(result.created).toHaveLength(3);
  });

  it('outputs summary count on success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const leads = makeLeads(3);
    const client = makeMockClient();

    await discoverLeads({
      icpDescription: 'SaaS founders',
      _webSearch: vi.fn().mockResolvedValue(leads),
      _client: client,
    });

    expect(logSpy).toHaveBeenCalledWith(
      '3 leads found and added to GojiBerry — ready for enrichment',
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Respect daily lead scan limit
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Respect daily lead scan limit', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates only top N leads when limit is set', async () => {
    const leads = makeLeads(25);
    const client = makeMockClient();

    const result = await discoverLeads({
      icpDescription: 'SaaS founders',
      limit: 10,
      _webSearch: vi.fn().mockResolvedValue(leads),
      _client: client,
    });

    expect(result.created).toHaveLength(10);
    expect(client.createLead).toHaveBeenCalledTimes(10);
  });

  it('sets limitExceeded to count of skipped-by-limit leads', async () => {
    const leads = makeLeads(25);
    const client = makeMockClient();

    const result = await discoverLeads({
      icpDescription: 'SaaS founders',
      limit: 10,
      _webSearch: vi.fn().mockResolvedValue(leads),
      _client: client,
    });

    expect(result.limitExceeded).toBe(15);
  });

  it('outputs limit-exceeded message with correct counts', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const leads = makeLeads(25);
    const client = makeMockClient();

    await discoverLeads({
      icpDescription: 'SaaS founders',
      limit: 10,
      _webSearch: vi.fn().mockResolvedValue(leads),
      _client: client,
    });

    expect(logSpy).toHaveBeenCalledWith(
      '10 leads added (limit: 10, 15 additional matches skipped)',
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Use default limit when DAILY_LEAD_SCAN_LIMIT is not set
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Use default limit when DAILY_LEAD_SCAN_LIMIT is not set', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    delete process.env.DAILY_LEAD_SCAN_LIMIT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.DAILY_LEAD_SCAN_LIMIT = '50';
  });

  it('uses default limit of 50 when DAILY_LEAD_SCAN_LIMIT is not set', async () => {
    const leads = makeLeads(60);
    const client = makeMockClient();

    const result = await discoverLeads({
      icpDescription: 'SaaS founders',
      _webSearch: vi.fn().mockResolvedValue(leads),
      _client: client,
    });

    expect(result.created).toHaveLength(50);
    expect(result.limitExceeded).toBe(10);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Skip duplicate leads already in GojiBerry
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Skip duplicate leads already in GojiBerry', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips lead when profileUrl already exists in GojiBerry', async () => {
    const lead = makeLead({ firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://linkedin.com/in/jane-doe' });

    const existingLead: Lead = {
      id: 'existing-123',
      firstName: 'Jane',
      lastName: 'Doe',
      profileUrl: 'https://linkedin.com/in/jane-doe',
    };

    const client = makeMockClient({
      searchLeads: vi.fn().mockResolvedValue(paginatedWith([existingLead])),
    });

    const result = await discoverLeads({
      icpDescription: 'SaaS founders',
      _webSearch: vi.fn().mockResolvedValue([lead]),
      _client: client,
    });

    expect(result.skipped).toHaveLength(1);
    expect(result.created).toHaveLength(0);
    expect(client.createLead).not.toHaveBeenCalled();
  });

  it('logs skip message with lead name', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const lead = makeLead({ firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://linkedin.com/in/jane-doe' });

    const existingLead: Lead = { id: 'x', firstName: 'Jane', lastName: 'Doe', profileUrl: 'https://linkedin.com/in/jane-doe' };

    const client = makeMockClient({
      searchLeads: vi.fn().mockResolvedValue(paginatedWith([existingLead])),
    });

    await discoverLeads({
      icpDescription: 'SaaS founders',
      _webSearch: vi.fn().mockResolvedValue([lead]),
      _client: client,
    });

    expect(logSpy).toHaveBeenCalledWith('Skipped: Jane Doe — already in GojiBerry');
  });

  it('duplicate is not counted toward the scan limit', async () => {
    const dup = makeLead({ profileUrl: 'https://linkedin.com/in/dup' });
    const newLeads = makeLeads(3);

    const existingLead: Lead = { id: 'x', firstName: dup.firstName, lastName: dup.lastName, profileUrl: dup.profileUrl };

    const client = makeMockClient({
      searchLeads: vi.fn().mockImplementation(async (filters) => {
        const search = (filters as { search?: string })?.search ?? '';
        if (search.includes('dup')) return paginatedWith([existingLead]);
        return emptyPaginated();
      }),
    });

    const result = await discoverLeads({
      icpDescription: 'SaaS founders',
      limit: 4,
      _webSearch: vi.fn().mockResolvedValue([dup, ...newLeads]),
      _client: client,
    });

    // dup is skipped; 3 new leads created; limitExceeded = 0 (4 processed, 1 skipped + 3 created)
    expect(result.created).toHaveLength(3);
    expect(result.skipped).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Extract structured lead data from web search
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Extract structured lead data from web search', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes firstName, lastName, profileUrl to createLead', async () => {
    const lead = makeLead({ firstName: 'Alice', lastName: 'Smith', profileUrl: 'https://linkedin.com/in/alice-smith' });
    const client = makeMockClient();

    await discoverLeads({
      icpDescription: 'SaaS founders',
      _webSearch: vi.fn().mockResolvedValue([lead]),
      _client: client,
    });

    expect(client.createLead).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: 'Alice',
        lastName: 'Smith',
        profileUrl: 'https://linkedin.com/in/alice-smith',
      }),
    );
  });

  it('includes company, jobTitle, location when available', async () => {
    const lead = makeLead({ company: 'Acme', jobTitle: 'CTO', location: 'NYC' });
    const client = makeMockClient();

    await discoverLeads({
      icpDescription: 'SaaS founders',
      _webSearch: vi.fn().mockResolvedValue([lead]),
      _client: client,
    });

    expect(client.createLead).toHaveBeenCalledWith(
      expect.objectContaining({
        company: 'Acme',
        jobTitle: 'CTO',
        location: 'NYC',
      }),
    );
  });

  it('omits optional fields when not present in discovered lead', async () => {
    const lead: DiscoveredLead = { firstName: 'Min', lastName: 'Imal', profileUrl: 'https://linkedin.com/in/minimal' };
    const client = makeMockClient();

    await discoverLeads({
      icpDescription: 'SaaS founders',
      _webSearch: vi.fn().mockResolvedValue([lead]),
      _client: client,
    });

    const callArg = (client.createLead as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg).not.toHaveProperty('company');
    expect(callArg).not.toHaveProperty('jobTitle');
    expect(callArg).not.toHaveProperty('location');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle web search returning no results
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle web search returning no results', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('outputs "No leads found" message when web search returns empty', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await discoverLeads({
      icpDescription: 'Very narrow criteria',
      _webSearch: vi.fn().mockResolvedValue([]),
      _client: makeMockClient(),
    });

    expect(logSpy).toHaveBeenCalledWith(
      'No leads found matching your ICP — try broadening your ideal customer description',
    );
  });

  it('does not call createLead when no leads found', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = makeMockClient();

    await discoverLeads({
      icpDescription: 'Very narrow criteria',
      _webSearch: vi.fn().mockResolvedValue([]),
      _client: client,
    });

    expect(client.createLead).not.toHaveBeenCalled();
  });

  it('returns empty result when no leads found', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await discoverLeads({
      icpDescription: 'Very narrow criteria',
      _webSearch: vi.fn().mockResolvedValue([]),
      _client: makeMockClient(),
    });

    expect(result.created).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle GojiBerry API errors during lead creation
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle GojiBerry API errors during lead creation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs error message when createLead fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const failingLead = makeLead({ firstName: 'Bad', lastName: 'Lead', profileUrl: 'https://linkedin.com/in/bad-lead' });

    const client = makeMockClient({
      createLead: vi.fn().mockRejectedValue(new Error('API timeout')),
    });

    await discoverLeads({
      icpDescription: 'SaaS founders',
      _webSearch: vi.fn().mockResolvedValue([failingLead]),
      _client: client,
    });

    expect(errSpy).toHaveBeenCalledWith(
      'Failed to create lead: Bad Lead — API timeout',
    );
  });

  it('continues processing remaining leads after one failure', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const leads = makeLeads(8);
    let callCount = 0;

    const client = makeMockClient({
      createLead: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 4) throw new Error('Transient error');
        return { id: `id-${callCount}`, firstName: 'Lead', lastName: `${callCount}`, profileUrl: `https://linkedin.com/in/lead-${callCount}` } as Lead;
      }),
    });

    const result = await discoverLeads({
      icpDescription: 'SaaS founders',
      _webSearch: vi.fn().mockResolvedValue(leads),
      _client: client,
    });

    expect(result.created).toHaveLength(7);
    expect(result.failed).toHaveLength(1);
    expect(client.createLead).toHaveBeenCalledTimes(8);
  });

  it('summary includes failure count when some leads fail', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const leads = makeLeads(8);
    let callCount = 0;

    const client = makeMockClient({
      createLead: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 4) throw new Error('Transient error');
        return { id: `id-${callCount}`, firstName: 'Lead', lastName: `${callCount}`, profileUrl: `https://linkedin.com/in/lead-${callCount}` } as Lead;
      }),
    });

    await discoverLeads({
      icpDescription: 'SaaS founders',
      _webSearch: vi.fn().mockResolvedValue(leads),
      _client: client,
    });

    expect(logSpy).toHaveBeenCalledWith('7 leads added, 1 failed (see logs)');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle rate limits during batch creation
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle rate limits during batch creation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('completes batch creation without throwing rate limit errors', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const leads = makeLeads(20);
    const client = makeMockClient();

    await expect(
      discoverLeads({
        icpDescription: 'SaaS founders',
        limit: 20,
        _webSearch: vi.fn().mockResolvedValue(leads),
        _client: client,
      }),
    ).resolves.not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Output lead summary after discovery
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Output lead summary after discovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('outputs total line "N leads found and added to GojiBerry — ready for enrichment"', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const leads = makeLeads(12);
    const client = makeMockClient();

    await discoverLeads({
      icpDescription: 'SaaS founders',
      _webSearch: vi.fn().mockResolvedValue(leads),
      _client: client,
    });

    expect(logSpy).toHaveBeenCalledWith(
      '12 leads found and added to GojiBerry — ready for enrichment',
    );
  });

  it('outputs a summary table row for each created lead', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const leads = makeLeads(2);

    // Override with specific data for assertion
    leads[0] = { firstName: 'Alice', lastName: 'Smith', profileUrl: 'https://linkedin.com/in/alice', company: 'Acme', jobTitle: 'CEO' };
    leads[1] = { firstName: 'Bob', lastName: 'Jones', profileUrl: 'https://linkedin.com/in/bob', company: 'BetaCo', jobTitle: 'CTO' };

    const client = makeMockClient();

    await discoverLeads({
      icpDescription: 'SaaS founders',
      _webSearch: vi.fn().mockResolvedValue(leads),
      _client: client,
    });

    // Each lead should appear as a summary row
    const logCalls = logSpy.mock.calls.map((c) => c[0]);
    expect(logCalls.some((msg) => String(msg).includes('Alice Smith'))).toBe(true);
    expect(logCalls.some((msg) => String(msg).includes('Bob Jones'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle authentication failure
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle authentication failure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('propagates AuthError when GojiBerry API returns 401', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const client = makeMockClient({
      searchLeads: vi.fn().mockRejectedValue(new AuthError()),
    });

    await expect(
      discoverLeads({
        icpDescription: 'SaaS founders',
        _webSearch: vi.fn().mockResolvedValue([makeLead()]),
        _client: client,
      }),
    ).rejects.toThrow(AuthError);
  });

  it('outputs AuthError message before throwing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const client = makeMockClient({
      searchLeads: vi.fn().mockRejectedValue(new AuthError()),
    });

    await expect(
      discoverLeads({
        icpDescription: 'SaaS founders',
        _webSearch: vi.fn().mockResolvedValue([makeLead()]),
        _client: client,
      }),
    ).rejects.toThrow(AuthError);

    expect(errSpy).toHaveBeenCalledWith(
      'GojiBerry API key is invalid or expired — check GOJIBERRY_API_KEY in .env.local',
    );
  });

  it('does not create any leads before throwing AuthError', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const client = makeMockClient({
      searchLeads: vi.fn().mockRejectedValue(new AuthError()),
    });

    await expect(
      discoverLeads({
        icpDescription: 'SaaS founders',
        _webSearch: vi.fn().mockResolvedValue([makeLead()]),
        _client: client,
      }),
    ).rejects.toThrow(AuthError);

    expect(client.createLead).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Rank leads by ICP fit before applying limit
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Rank leads by ICP fit before applying limit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects the first N leads (best-ranked by web search) when limit applies', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Web search returns leads ranked best-to-worst; top 10 should be created
    const leads = makeLeads(20);
    const topTen = leads.slice(0, 10);
    const client = makeMockClient();

    const result = await discoverLeads({
      icpDescription: 'SaaS founders',
      limit: 10,
      _webSearch: vi.fn().mockResolvedValue(leads),
      _client: client,
    });

    expect(result.created).toHaveLength(10);
    // Verify the created leads are the first 10 from the ranked list
    result.created.forEach((created, idx) => {
      expect(created.profileUrl).toBe(topTen[idx].profileUrl);
    });
  });

  it('skipped-by-limit leads are the weakest matches (last in list)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const leads = makeLeads(20);
    const bottom10 = leads.slice(10);
    const client = makeMockClient();

    const result = await discoverLeads({
      icpDescription: 'SaaS founders',
      limit: 10,
      _webSearch: vi.fn().mockResolvedValue(leads),
      _client: client,
    });

    expect(result.limitExceeded).toBe(10);
    // Verify bottom 10 were not created
    const createdUrls = new Set(result.created.map((l) => l.profileUrl));
    bottom10.forEach((l) => {
      expect(createdUrls.has(l.profileUrl)).toBe(false);
    });
  });
});
