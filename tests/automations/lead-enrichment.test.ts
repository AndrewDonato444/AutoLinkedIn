import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enrichLeads } from '../../src/automations/lead-enrichment.js';
import { ConfigError, AuthError } from '../../src/api/errors.js';
import type { Lead, PaginatedLeads, UpdateLeadInput } from '../../src/api/types.js';
import type { IntentResearch } from '../../src/automations/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1',
    firstName: 'Jane',
    lastName: 'Doe',
    profileUrl: 'https://linkedin.com/in/jane-doe',
    company: 'FinPay',
    jobTitle: 'CEO',
    location: 'San Francisco, CA',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeLeads(count: number, withScore = false): Lead[] {
  return Array.from({ length: count }, (_, i) =>
    makeLead({
      id: `lead-${i + 1}`,
      firstName: 'Lead',
      lastName: `${i + 1}`,
      profileUrl: `https://linkedin.com/in/lead-${i + 1}`,
      createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      ...(withScore ? { fit: 'qualified' as const, profileBaseline: `ICP Score: ${60 + i}/100\nReasoning: Good match` } : {}),
    }),
  );
}

function makeResearch(overrides: Partial<IntentResearch> = {}): IntentResearch {
  return {
    fitScore: 75,
    intentSignals: ['Recently raised Series A', 'Hiring 3 SDRs'],
    reasoning: 'Strong ICP match with clear buying signals',
    ...overrides,
  };
}

function emptyPaginated(): PaginatedLeads {
  return { leads: [], total: 0, page: 1, pageSize: 25 };
}

function paginatedWith(leads: Lead[], total?: number): PaginatedLeads {
  return { leads, total: total ?? leads.length, page: 1, pageSize: leads.length || 25 };
}

type MockClient = {
  searchLeads: ReturnType<typeof vi.fn>;
  getLead: ReturnType<typeof vi.fn>;
  updateLead: ReturnType<typeof vi.fn>;
};

function makeMockClient(overrides: Partial<{
  searchLeads: (filters?: unknown) => Promise<PaginatedLeads>;
  getLead: (id: string) => Promise<Lead>;
  updateLead: (id: string, updates: UpdateLeadInput) => Promise<Lead>;
}> = {}): MockClient {
  return {
    searchLeads: overrides.searchLeads
      ? vi.fn().mockImplementation(overrides.searchLeads)
      : vi.fn().mockResolvedValue(emptyPaginated()),
    getLead: overrides.getLead
      ? vi.fn().mockImplementation(overrides.getLead)
      : vi.fn().mockResolvedValue(makeLead()),
    updateLead: overrides.updateLead
      ? vi.fn().mockImplementation(overrides.updateLead)
      : vi.fn().mockImplementation(async (_id: string, updates: UpdateLeadInput) =>
          makeLead({ ...updates }),
        ),
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
    await expect(enrichLeads()).rejects.toThrow(ConfigError);
  });

  it('ConfigError message instructs founder to set ICP_DESCRIPTION', async () => {
    await expect(enrichLeads()).rejects.toThrow(
      'Missing ICP_DESCRIPTION in .env.local — describe your ideal customer first',
    );
  });

  it('throws ConfigError when ICP_DESCRIPTION is empty string', async () => {
    await expect(enrichLeads({ icpDescription: '' })).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError when ICP_DESCRIPTION is whitespace only', async () => {
    await expect(enrichLeads({ icpDescription: '   ' })).rejects.toThrow(ConfigError);
  });

  it('does not call webResearch when ICP is missing', async () => {
    const webResearch = vi.fn();
    await expect(enrichLeads({ _webResearch: webResearch })).rejects.toThrow(ConfigError);
    expect(webResearch).not.toHaveBeenCalled();
  });

  it('does not enrich any leads when ICP is missing', async () => {
    const client = makeMockClient();
    await expect(
      enrichLeads({ _client: client, _webResearch: vi.fn() }),
    ).rejects.toThrow(ConfigError);
    expect(client.searchLeads).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Enrich leads with buying signals and fit score
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Enrich leads with buying signals and fit score', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls webResearch for each unenriched lead', async () => {
    const leads = makeLeads(3);
    const client = makeMockClient({ searchLeads: async () => paginatedWith(leads) });
    const webResearch = vi.fn().mockResolvedValue(makeResearch());

    await enrichLeads({
      icpDescription: 'Series A SaaS founders in fintech who are actively hiring',
      _client: client,
      _webResearch: webResearch,
    });

    expect(webResearch).toHaveBeenCalledTimes(3);
  });

  it('passes the lead and ICP description to webResearch', async () => {
    const lead = makeLead();
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });
    const webResearch = vi.fn().mockResolvedValue(makeResearch());

    await enrichLeads({
      icpDescription: 'Series A SaaS founders in fintech who are actively hiring',
      _client: client,
      _webResearch: webResearch,
    });

    expect(webResearch).toHaveBeenCalledWith(
      lead,
      'Series A SaaS founders in fintech who are actively hiring',
    );
  });

  it('calls updateLead with fitScore and intentSignals from research', async () => {
    const lead = makeLead();
    const research = makeResearch({ fitScore: 80, intentSignals: ['Signal A', 'Signal B'] });
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(research),
    });

    expect(client.updateLead).toHaveBeenCalledWith(
      lead.id,
      expect.objectContaining({
        fit: 'qualified',
        profileBaseline: expect.stringContaining('ICP Score:'),
      }),
    );
  });

  it('returns enriched leads in result.enriched', async () => {
    const leads = makeLeads(3);
    const client = makeMockClient({ searchLeads: async () => paginatedWith(leads) });

    const result = await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    expect(result.enriched).toHaveLength(3);
  });

  it('each enriched entry has lead and research', async () => {
    const lead = makeLead();
    const research = makeResearch();
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    const result = await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(research),
    });

    expect(result.enriched[0]).toMatchObject({ lead, research });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Identify unenriched leads
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Identify unenriched leads', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips leads that already have a fitScore', async () => {
    const unenriched = makeLead({ id: 'u1', firstName: 'New', lastName: 'Lead' });
    const alreadyEnriched = makeLead({ id: 'e1', firstName: 'Old', lastName: 'Lead', fit: 'qualified' });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([unenriched, alreadyEnriched]),
    });
    const webResearch = vi.fn().mockResolvedValue(makeResearch());

    const result = await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: webResearch,
    });

    expect(webResearch).toHaveBeenCalledTimes(1);
    expect(result.enriched).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].id).toBe('e1');
  });

  it('puts already-enriched leads into result.skipped', async () => {
    const enrichedLeads = makeLeads(3, true); // all have fitScore
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(enrichedLeads),
    });

    const result = await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    expect(result.skipped).toHaveLength(3);
    expect(result.enriched).toHaveLength(0);
  });

  it('processes leads with fitScore of null as unenriched', async () => {
    const lead = makeLead({ fit: undefined });
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });
    const webResearch = vi.fn().mockResolvedValue(makeResearch());

    await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: webResearch,
    });

    expect(webResearch).toHaveBeenCalledTimes(1);
  });

  it('fetches with pageSize equal to batchSize', async () => {
    const client = makeMockClient();

    await enrichLeads({
      icpDescription: 'fintech founders',
      batchSize: 10,
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    expect(client.searchLeads).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 10 }),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Research a lead's online activity (integration of research output)
// ──────────────────────────────────────────────────────────────────────────────

describe("Scenario: Research a lead's online activity", () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses intent signals from research when updating the lead', async () => {
    const lead = makeLead({ firstName: 'Jane', lastName: 'Doe' });
    const signals = ['Recently raised Series A', 'Hiring 3 SDRs', 'Posted about outbound challenges'];
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch({ intentSignals: signals })),
    });

    expect(client.updateLead).toHaveBeenCalledWith(
      lead.id,
      expect.objectContaining({
        profileBaseline: expect.stringContaining('Recently raised Series A'),
      }),
    );
  });

  it('stores human-readable signal strings (not codes)', async () => {
    const lead = makeLead();
    const signals = ['Recently raised Series A', 'Hiring 3 SDRs'];
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch({ intentSignals: signals })),
    });

    const updateCall = client.updateLead.mock.calls[0][1] as UpdateLeadInput;
    expect(typeof updateCall.profileBaseline).toBe('string');
    expect(updateCall.profileBaseline).toContain('Recently raised Series A');
    expect(updateCall.profileBaseline).toContain('Hiring 3 SDRs');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Score a lead based on ICP fit and intent
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Score a lead based on ICP fit and intent', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updates lead with the fitScore returned by webResearch', async () => {
    const lead = makeLead();
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch({ fitScore: 87 })),
    });

    expect(client.updateLead).toHaveBeenCalledWith(
      lead.id,
      expect.objectContaining({
        fit: 'qualified',
        profileBaseline: expect.stringContaining('ICP Score: 87/100'),
      }),
    );
  });

  it('fitScore in result.enriched matches what was returned by webResearch', async () => {
    const lead = makeLead();
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    const result = await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch({ fitScore: 72 })),
    });

    expect(result.enriched[0].research.fitScore).toBe(72);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Apply MIN_INTENT_SCORE threshold for warm classification
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Apply MIN_INTENT_SCORE threshold for warm classification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('summary classifies leads at or above threshold as warm', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const lead = makeLead();
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      minIntentScore: 60,
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch({ fitScore: 75 })),
    });

    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('warm'))).toBe(true);
  });

  it('summary classifies leads below threshold as cold', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const lead = makeLead();
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      minIntentScore: 60,
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch({ fitScore: 45 })),
    });

    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('cold'))).toBe(true);
  });

  it('uses the provided minIntentScore for classification', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const warmLead = makeLead({ id: 'w1' });
    const coldLead = makeLead({ id: 'c1', firstName: 'Cold', lastName: 'Lead' });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([warmLead, coldLead]),
    });

    let callIndex = 0;
    const webResearch = vi.fn().mockImplementation(async () => {
      callIndex++;
      return makeResearch({ fitScore: callIndex === 1 ? 75 : 40 });
    });

    await enrichLeads({
      icpDescription: 'fintech founders',
      minIntentScore: 60,
      _client: client,
      _webResearch: webResearch,
    });

    const totalsLine = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('warm') && l.includes('cold'));
    expect(totalsLine).toContain('1 warm');
    expect(totalsLine).toContain('1 cold');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Use default MIN_INTENT_SCORE when not configured
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Use default MIN_INTENT_SCORE when not configured', () => {
  beforeEach(() => {
    delete process.env.MIN_INTENT_SCORE;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses default threshold of 50 when MIN_INTENT_SCORE is not set', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const lead = makeLead();
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch({ fitScore: 50 })),
    });

    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('warm'))).toBe(true);
  });

  it('lead scoring 49 is classified as cold with default threshold of 50', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const lead = makeLead();
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch({ fitScore: 49 })),
    });

    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('cold'))).toBe(true);
  });

  it('summary includes threshold value of 50 in totals line', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const lead = makeLead();
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('threshold: 50'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Respect enrichment batch size
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Respect enrichment batch size', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches leads with pageSize equal to batchSize', async () => {
    const client = makeMockClient({ searchLeads: async () => paginatedWith(makeLeads(15), 30) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      batchSize: 15,
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    expect(client.searchLeads).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 15 }),
    );
  });

  it('enriches only leads in the fetched batch', async () => {
    const client = makeMockClient({ searchLeads: async () => paginatedWith(makeLeads(15), 30) });
    const webResearch = vi.fn().mockResolvedValue(makeResearch());

    const result = await enrichLeads({
      icpDescription: 'fintech founders',
      batchSize: 15,
      _client: client,
      _webResearch: webResearch,
    });

    expect(webResearch).toHaveBeenCalledTimes(15);
    expect(result.enriched).toHaveLength(15);
  });

  it('sets remaining to total minus page size', async () => {
    const client = makeMockClient({ searchLeads: async () => paginatedWith(makeLeads(15), 30) });

    const result = await enrichLeads({
      icpDescription: 'fintech founders',
      batchSize: 15,
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    expect(result.remaining).toBe(15); // 30 - 15 = 15
  });

  it('outputs "run again to continue" when remaining > 0', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = makeMockClient({ searchLeads: async () => paginatedWith(makeLeads(15), 30) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      batchSize: 15,
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('run again'))).toBe(true);
    expect(logs.some((l) => l.includes('15 remaining'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Use default batch size when not configured
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Use default batch size when not configured', () => {
  beforeEach(() => {
    delete process.env.ENRICHMENT_BATCH_SIZE;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses default pageSize of 25 when ENRICHMENT_BATCH_SIZE is not set', async () => {
    const client = makeMockClient();

    await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    expect(client.searchLeads).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 25 }),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle web research returning no signals
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle web research returning no signals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs "Low signal" message when intentSignals is empty', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const lead = makeLead({ firstName: 'Jane', lastName: 'Doe' });
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch({ intentSignals: [] })),
    });

    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('Low signal: Jane Doe'))).toBe(true);
    expect(logs.some((l) => l.includes('no buying signals found'))).toBe(true);
  });

  it('still updates lead with fitScore even when no signals found', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const lead = makeLead();
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch({ fitScore: 30, intentSignals: [] })),
    });

    expect(client.updateLead).toHaveBeenCalledWith(
      lead.id,
      expect.objectContaining({
        fit: 'unknown',
        profileBaseline: expect.stringContaining('ICP Score: 30/100'),
      }),
    );
  });

  it('sets intentSignals to empty array in result when no signals found', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const lead = makeLead();
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    const result = await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch({ intentSignals: [] })),
    });

    expect(result.enriched[0].research.intentSignals).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle GojiBerry API errors during enrichment
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle GojiBerry API errors during enrichment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs "Failed to update lead" message when updateLead throws', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const lead = makeLead({ firstName: 'Jane', lastName: 'Doe' });
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
      updateLead: async () => { throw new Error('DB write failed'); },
    });

    await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to update lead: Jane Doe'),
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('DB write failed'),
    );
  });

  it('continues enriching remaining leads after one fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const leads = makeLeads(5);
    let callCount = 0;

    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
      updateLead: async (_id: string, updates: UpdateLeadInput) => {
        callCount++;
        if (callCount === 3) throw new Error('API error');
        return makeLead(updates);
      },
    });

    const result = await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    expect(result.enriched).toHaveLength(4);
    expect(result.failed).toHaveLength(1);
    expect(client.updateLead).toHaveBeenCalledTimes(5);
  });

  it('records failed lead in result.failed with error message', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const lead = makeLead();
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
      updateLead: async () => { throw new Error('Timeout'); },
    });

    const result = await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].lead).toEqual(lead);
    expect(result.failed[0].error).toContain('Timeout');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle rate limits during batch enrichment
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle rate limits during batch enrichment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('completes batch enrichment without throwing rate limit errors', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const leads = makeLeads(25);
    const client = makeMockClient({ searchLeads: async () => paginatedWith(leads) });

    await expect(
      enrichLeads({
        icpDescription: 'fintech founders',
        batchSize: 25,
        _client: client,
        _webResearch: vi.fn().mockResolvedValue(makeResearch()),
      }),
    ).resolves.not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle authentication failure
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle authentication failure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('propagates AuthError when searchLeads throws AuthError', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const client = makeMockClient({
      searchLeads: async () => { throw new AuthError(); },
    });

    await expect(
      enrichLeads({
        icpDescription: 'fintech founders',
        _client: client,
        _webResearch: vi.fn().mockResolvedValue(makeResearch()),
      }),
    ).rejects.toThrow(AuthError);
  });

  it('propagates AuthError when updateLead throws AuthError', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const lead = makeLead();
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
      updateLead: async () => { throw new AuthError(); },
    });

    await expect(
      enrichLeads({
        icpDescription: 'fintech founders',
        _client: client,
        _webResearch: vi.fn().mockResolvedValue(makeResearch()),
      }),
    ).rejects.toThrow(AuthError);
  });

  it('logs AuthError message before re-throwing from updateLead', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const lead = makeLead();
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([lead]),
      updateLead: async () => { throw new AuthError(); },
    });

    await expect(
      enrichLeads({
        icpDescription: 'fintech founders',
        _client: client,
        _webResearch: vi.fn().mockResolvedValue(makeResearch()),
      }),
    ).rejects.toThrow(AuthError);

    expect(errSpy).toHaveBeenCalledWith(
      'GojiBerry API key is invalid or expired — check GOJIBERRY_API_KEY in .env.local',
    );
  });

  it('does not enrich any leads when initial fetch throws AuthError', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const client = makeMockClient({
      searchLeads: async () => { throw new AuthError(); },
    });

    await expect(
      enrichLeads({
        icpDescription: 'fintech founders',
        _client: client,
        _webResearch: vi.fn(),
      }),
    ).rejects.toThrow(AuthError);

    expect(client.updateLead).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Output enrichment summary
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Output enrichment summary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('outputs totals line: "N leads enriched — X warm, Y cold (threshold: T)"', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const leads = makeLeads(12);
    const client = makeMockClient({ searchLeads: async () => paginatedWith(leads) });

    let callIdx = 0;
    const webResearch = vi.fn().mockImplementation(async () => {
      callIdx++;
      return makeResearch({ fitScore: callIdx <= 7 ? 65 : 35 });
    });

    await enrichLeads({
      icpDescription: 'fintech founders',
      minIntentScore: 50,
      _client: client,
      _webResearch: webResearch,
    });

    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('12 leads enriched'))).toBe(true);
    expect(logs.some((l) => l.includes('7 warm'))).toBe(true);
    expect(logs.some((l) => l.includes('5 cold'))).toBe(true);
    expect(logs.some((l) => l.includes('threshold: 50'))).toBe(true);
  });

  it('outputs summary table rows for each enriched lead', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const lead = makeLead({ firstName: 'Alice', lastName: 'Smith', company: 'Acme' });
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch({ intentSignals: ['Signal 1', 'Signal 2'] })),
    });

    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('Alice Smith'))).toBe(true);
  });

  it('outputs warm leads summary with score and top signal', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const lead = makeLead({ firstName: 'Jane', lastName: 'Doe', company: 'FinPay' });
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      minIntentScore: 50,
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch({
        fitScore: 85,
        intentSignals: ['Recently raised Series A'],
      })),
    });

    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    const hasScoreInOutput = logs.some((l) => l.includes('85'));
    expect(hasScoreInOutput).toBe(true);
  });

  it('includes failure count in summary when some leads failed', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const leads = makeLeads(3);
    let callCount = 0;
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
      updateLead: async (_id: string, updates: UpdateLeadInput) => {
        callCount++;
        if (callCount === 2) throw new Error('API error');
        return makeLead(updates);
      },
    });

    await enrichLeads({
      icpDescription: 'fintech founders',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('failed'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Re-enrich a lead (force refresh)
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Re-enrich a lead (force refresh)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-researches leads that already have a fitScore when forceRefresh is true', async () => {
    const enrichedLeads = makeLeads(3, true); // all have fitScore
    const client = makeMockClient({ searchLeads: async () => paginatedWith(enrichedLeads) });
    const webResearch = vi.fn().mockResolvedValue(makeResearch({ fitScore: 90 }));

    await enrichLeads({
      icpDescription: 'fintech founders',
      forceRefresh: true,
      _client: client,
      _webResearch: webResearch,
    });

    expect(webResearch).toHaveBeenCalledTimes(3);
  });

  it('updates GojiBerry with new score and signals on forceRefresh', async () => {
    const lead = makeLead({ fit: 'unknown' });
    const client = makeMockClient({ searchLeads: async () => paginatedWith([lead]) });

    await enrichLeads({
      icpDescription: 'fintech founders',
      forceRefresh: true,
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch({ fitScore: 82, intentSignals: ['New signal'] })),
    });

    expect(client.updateLead).toHaveBeenCalledWith(
      lead.id,
      expect.objectContaining({
        fit: 'qualified',
        profileBaseline: expect.stringContaining('ICP Score: 82/100'),
      }),
    );
  });

  it('does not put leads in skipped when forceRefresh is true', async () => {
    const enrichedLeads = makeLeads(2, true);
    const client = makeMockClient({ searchLeads: async () => paginatedWith(enrichedLeads) });

    const result = await enrichLeads({
      icpDescription: 'fintech founders',
      forceRefresh: true,
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    expect(result.skipped).toHaveLength(0);
    expect(result.enriched).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Enrich a specific lead by ID
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Enrich a specific lead by ID', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches the specific lead via getLead when leadId is provided', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const lead = makeLead({ id: 'target-123', firstName: 'John', lastName: 'Smith' });
    const client = makeMockClient({ getLead: async () => lead });

    await enrichLeads({
      icpDescription: 'fintech founders',
      leadId: 'target-123',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    expect(client.getLead).toHaveBeenCalledWith('target-123');
    expect(logSpy).toBeDefined();
  });

  it('does not call searchLeads when leadId is provided', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const lead = makeLead({ id: 'target-123' });
    const client = makeMockClient({ getLead: async () => lead });

    await enrichLeads({
      icpDescription: 'fintech founders',
      leadId: 'target-123',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    expect(client.searchLeads).not.toHaveBeenCalled();
  });

  it('researches and updates just that lead', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const lead = makeLead({ id: 'target-123' });
    const research = makeResearch({ fitScore: 78, intentSignals: ['Signal A'] });
    const client = makeMockClient({ getLead: async () => lead });

    await enrichLeads({
      icpDescription: 'fintech founders',
      leadId: 'target-123',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(research),
    });

    expect(client.updateLead).toHaveBeenCalledWith(
      lead.id,
      expect.objectContaining({
        fit: 'qualified',
        profileBaseline: expect.stringContaining('ICP Score: 78/100'),
      }),
    );
  });

  it('outputs single-lead summary: "{firstName} {lastName} — score: {score}, signals: {list}"', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const lead = makeLead({ id: 'target-123', firstName: 'John', lastName: 'Smith' });
    const client = makeMockClient({ getLead: async () => lead });

    await enrichLeads({
      icpDescription: 'fintech founders',
      leadId: 'target-123',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch({ fitScore: 78, intentSignals: ['Signal A'] })),
    });

    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('John Smith'))).toBe(true);
    expect(logs.some((l) => l.includes('score: 78'))).toBe(true);
    expect(logs.some((l) => l.includes('Signal A'))).toBe(true);
  });

  it('returns result with the single enriched lead', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const lead = makeLead({ id: 'target-123' });
    const client = makeMockClient({ getLead: async () => lead });

    const result = await enrichLeads({
      icpDescription: 'fintech founders',
      leadId: 'target-123',
      _client: client,
      _webResearch: vi.fn().mockResolvedValue(makeResearch()),
    });

    expect(result.enriched).toHaveLength(1);
    expect(result.enriched[0].lead.id).toBe('target-123');
  });
});
