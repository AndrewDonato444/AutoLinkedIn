import { describe, it, expect, vi } from 'vitest';
import { buildWarmLeadList } from '../../src/automations/warm-lead-list-builder.js';
import { AuthError } from '../../src/api/errors.js';
import type { Lead, PaginatedLeads } from '../../src/api/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1',
    firstName: 'Jane',
    lastName: 'Smith',
    profileUrl: 'https://linkedin.com/in/janesmith',
    company: 'Acme Corp',
    jobTitle: 'VP of Sales',
    fitScore: 75,
    intentType: 'hiring',
    intentSignals: ['Recently raised Series B', 'Hiring 3 SDRs'],
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-10T00:00:00Z',
    ...overrides,
  };
}

function makePaginatedLeads(leads: Lead[], overrides: Partial<PaginatedLeads> = {}): PaginatedLeads {
  return {
    leads,
    total: leads.length,
    page: 1,
    pageSize: 250,
    ...overrides,
  };
}

type MockClient = {
  searchLeads: ReturnType<typeof vi.fn>;
};

function makeMockClient(pages: PaginatedLeads[]): MockClient {
  const fn = vi.fn();
  pages.forEach((page, i) => fn.mockResolvedValueOnce(page));
  return { searchLeads: fn };
}

function makeMockClientThrowing(error: Error): MockClient {
  return {
    searchLeads: vi.fn().mockRejectedValue(error),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Build a warm lead list with default filters
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Build a warm lead list with default filters', () => {
  it('fetches leads with scoreFrom set to MIN_INTENT_SCORE from env (60 in this env)', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead()])]);
    await buildWarmLeadList(undefined, { _client: client });
    // MIN_INTENT_SCORE=60 in .env.local; fallback default is 50 when env unset
    expect(client.searchLeads).toHaveBeenCalledWith(
      expect.objectContaining({ scoreFrom: expect.any(Number) }),
    );
    const callArgs = client.searchLeads.mock.calls[0][0];
    expect(callArgs.scoreFrom).toBeGreaterThanOrEqual(50);
  });

  it('sorts results by fitScore descending (highest first)', async () => {
    const leads = [
      makeLead({ id: 'a', firstName: 'Low', fitScore: 55 }),
      makeLead({ id: 'b', firstName: 'High', fitScore: 90 }),
      makeLead({ id: 'c', firstName: 'Mid', fitScore: 72 }),
    ];
    const client = makeMockClient([makePaginatedLeads(leads)]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.leads[0].fitScore).toBe(90);
    expect(result.leads[1].fitScore).toBe(72);
    expect(result.leads[2].fitScore).toBe(55);
  });

  it('generates a reason for warmth for each lead', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead({ fitScore: 75, intentSignals: ['Hiring SDRs'] })])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.leads[0].reasonForWarmth).toBeTruthy();
    expect(result.leads[0].reasonForWarmth.length).toBeGreaterThan(0);
  });

  it('includes lead name, company, score, intentType, and reason in output', async () => {
    const lead = makeLead({ firstName: 'Jane', lastName: 'Smith', company: 'Acme', fitScore: 75, intentType: 'hiring' });
    const client = makeMockClient([makePaginatedLeads([lead])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    const warmLead = result.leads[0];
    expect(warmLead.firstName).toBe('Jane');
    expect(warmLead.lastName).toBe('Smith');
    expect(warmLead.company).toBe('Acme');
    expect(warmLead.fitScore).toBe(75);
    expect(warmLead.intentType).toBe('hiring');
    expect(warmLead.reasonForWarmth).toBeTruthy();
  });

  it('reflects MIN_INTENT_SCORE env value in filters output when no scoreFrom provided', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead()])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    // MIN_INTENT_SCORE=60 in .env.local; fallback default is 50 when env unset
    expect(result.filters.scoreFrom).toBeGreaterThanOrEqual(50);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Build a warm lead list with custom score range
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Build a warm lead list with custom score range', () => {
  it('fetches only leads with fitScores between scoreFrom and scoreTo', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead({ fitScore: 85 })])]);
    await buildWarmLeadList({ scoreFrom: 80, scoreTo: 100 }, { _client: client });
    expect(client.searchLeads).toHaveBeenCalledWith(
      expect.objectContaining({ scoreFrom: 80, scoreTo: 100 }),
    );
  });

  it('labels all leads in 80-100 range as Hot tier', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead({ fitScore: 85 })])]);
    const result = await buildWarmLeadList({ scoreFrom: 80, scoreTo: 100 }, { _client: client });
    expect(result.leads[0].scoreTier).toBe('hot');
  });

  it('outputs the prioritized list', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead({ fitScore: 85 })])]);
    const result = await buildWarmLeadList({ scoreFrom: 80, scoreTo: 100 }, { _client: client });
    expect(result.leads).toHaveLength(1);
    expect(result.reportText).toContain('Warm Lead List');
  });

  it('reflects custom scoreFrom and scoreTo in filters output', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead({ fitScore: 90 })])]);
    const result = await buildWarmLeadList({ scoreFrom: 80, scoreTo: 100 }, { _client: client });
    expect(result.filters.scoreFrom).toBe(80);
    expect(result.filters.scoreTo).toBe(100);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Build a warm lead list filtered by date range
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Build a warm lead list filtered by date range', () => {
  it('fetches only leads within the provided date range', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead()])]);
    await buildWarmLeadList({ dateFrom: '2026-04-01', dateTo: '2026-04-13' }, { _client: client });
    expect(client.searchLeads).toHaveBeenCalledWith(
      expect.objectContaining({ dateFrom: '2026-04-01', dateTo: '2026-04-13' }),
    );
  });

  it('applies default score threshold when no scoreFrom is provided', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead()])]);
    await buildWarmLeadList({ dateFrom: '2026-04-01', dateTo: '2026-04-13' }, { _client: client });
    const callArgs = client.searchLeads.mock.calls[0][0];
    expect(callArgs.scoreFrom).toBeGreaterThanOrEqual(50);
  });

  it('includes date filters in the result filters object', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead()])]);
    const result = await buildWarmLeadList({ dateFrom: '2026-04-01', dateTo: '2026-04-13' }, { _client: client });
    expect(result.filters.dateFrom).toBe('2026-04-01');
    expect(result.filters.dateTo).toBe('2026-04-13');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Build a warm lead list filtered by intent type
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Build a warm lead list filtered by intent type', () => {
  it('fetches only leads tagged with the provided intent type', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead({ intentType: 'hiring' })])]);
    await buildWarmLeadList({ intentType: 'hiring' }, { _client: client });
    expect(client.searchLeads).toHaveBeenCalledWith(
      expect.objectContaining({ intentType: 'hiring' }),
    );
  });

  it('applies default score threshold with intent type filter', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead()])]);
    await buildWarmLeadList({ intentType: 'hiring' }, { _client: client });
    const callArgs = client.searchLeads.mock.calls[0][0];
    expect(callArgs.scoreFrom).toBeGreaterThanOrEqual(50);
  });

  it('includes intentType in the result filters object', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead({ intentType: 'hiring' })])]);
    const result = await buildWarmLeadList({ intentType: 'hiring' }, { _client: client });
    expect(result.filters.intentType).toBe('hiring');
  });

  it('outputs prioritized list grouped by intent type in reportText', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead({ intentType: 'hiring', fitScore: 85 })])]);
    const result = await buildWarmLeadList({ intentType: 'hiring' }, { _client: client });
    expect(result.reportText).toContain('hiring');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Combine all filters
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Combine all filters', () => {
  it('passes all filters to searchLeads in a single API call', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead({ fitScore: 85 })])]);
    await buildWarmLeadList(
      { scoreFrom: 80, scoreTo: 100, dateFrom: '2026-04-01', dateTo: '2026-04-13', intentType: 'hiring' },
      { _client: client },
    );
    expect(client.searchLeads).toHaveBeenCalledTimes(1);
    expect(client.searchLeads).toHaveBeenCalledWith(
      expect.objectContaining({
        scoreFrom: 80,
        scoreTo: 100,
        dateFrom: '2026-04-01',
        dateTo: '2026-04-13',
        intentType: 'hiring',
      }),
    );
  });

  it('all filters appear in the result filters object', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead({ fitScore: 85 })])]);
    const result = await buildWarmLeadList(
      { scoreFrom: 80, scoreTo: 100, dateFrom: '2026-04-01', dateTo: '2026-04-13', intentType: 'hiring' },
      { _client: client },
    );
    expect(result.filters.scoreFrom).toBe(80);
    expect(result.filters.scoreTo).toBe(100);
    expect(result.filters.dateFrom).toBe('2026-04-01');
    expect(result.filters.dateTo).toBe('2026-04-13');
    expect(result.filters.intentType).toBe('hiring');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Paginate through large result sets
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Paginate through large result sets', () => {
  it('fetches page 1 and checks if total > pageSize', async () => {
    const page1Leads = [makeLead({ id: 'a', fitScore: 90 }), makeLead({ id: 'b', fitScore: 80 })];
    const page2Leads = [makeLead({ id: 'c', fitScore: 70 })];
    const client = makeMockClient([
      makePaginatedLeads(page1Leads, { total: 3, page: 1, pageSize: 2 }),
      makePaginatedLeads(page2Leads, { total: 3, page: 2, pageSize: 2 }),
    ]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(client.searchLeads).toHaveBeenCalledTimes(2);
    expect(result.leads).toHaveLength(3);
  });

  it('continues fetching until all matching leads are collected', async () => {
    const page1Leads = Array.from({ length: 3 }, (_, i) =>
      makeLead({ id: `lead-${i}`, fitScore: 90 - i * 5 }),
    );
    const page2Leads = Array.from({ length: 3 }, (_, i) =>
      makeLead({ id: `lead-${i + 3}`, fitScore: 70 - i * 5 }),
    );
    const page3Leads = [makeLead({ id: 'lead-6', fitScore: 52 })];
    const client = makeMockClient([
      makePaginatedLeads(page1Leads, { total: 7, page: 1, pageSize: 3 }),
      makePaginatedLeads(page2Leads, { total: 7, page: 2, pageSize: 3 }),
      makePaginatedLeads(page3Leads, { total: 7, page: 3, pageSize: 3 }),
    ]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(client.searchLeads).toHaveBeenCalledTimes(3);
    expect(result.leads).toHaveLength(7);
  });

  it('combines all pages into a single sorted list', async () => {
    const page1Leads = [makeLead({ id: 'a', fitScore: 55 })];
    const page2Leads = [makeLead({ id: 'b', fitScore: 95 })];
    const client = makeMockClient([
      makePaginatedLeads(page1Leads, { total: 2, page: 1, pageSize: 1 }),
      makePaginatedLeads(page2Leads, { total: 2, page: 2, pageSize: 1 }),
    ]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    // sorted descending: 95 first, then 55
    expect(result.leads[0].fitScore).toBe(95);
    expect(result.leads[1].fitScore).toBe(55);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate reason-for-warmth per lead
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate reason-for-warmth per lead', () => {
  it('reason includes the score tier "Hot" for score >= 80', async () => {
    const lead = makeLead({ fitScore: 85, intentSignals: ['Recently raised Series B', 'Hiring 3 SDRs'] });
    const client = makeMockClient([makePaginatedLeads([lead])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.leads[0].reasonForWarmth).toContain('Hot');
  });

  it('reason includes all intent signals', async () => {
    const lead = makeLead({ fitScore: 85, intentSignals: ['Recently raised Series B', 'Hiring 3 SDRs'] });
    const client = makeMockClient([makePaginatedLeads([lead])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.leads[0].reasonForWarmth).toContain('Recently raised Series B');
    expect(result.leads[0].reasonForWarmth).toContain('Hiring 3 SDRs');
  });

  it('reason reads naturally with score and signals', async () => {
    const lead = makeLead({ fitScore: 85, intentSignals: ['Recently raised Series B', 'Hiring 3 SDRs'] });
    const client = makeMockClient([makePaginatedLeads([lead])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    // e.g. "Hot lead (score: 85) — Recently raised Series B, Hiring 3 SDRs"
    expect(result.leads[0].reasonForWarmth).toMatch(/Hot lead \(score: 85\)/);
    expect(result.leads[0].reasonForWarmth).toContain('Recently raised Series B');
  });

  it('assigns scoreTier "hot" for fitScore >= 80', async () => {
    const lead = makeLead({ fitScore: 85 });
    const client = makeMockClient([makePaginatedLeads([lead])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.leads[0].scoreTier).toBe('hot');
  });

  it('assigns scoreTier "warm" for fitScore 50-79', async () => {
    const lead = makeLead({ fitScore: 65 });
    const client = makeMockClient([makePaginatedLeads([lead])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.leads[0].scoreTier).toBe('warm');
  });

  it('reason includes "Warm" for score in 50-79 range', async () => {
    const lead = makeLead({ fitScore: 65, intentSignals: ['Expanding to new market'] });
    const client = makeMockClient([makePaginatedLeads([lead])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.leads[0].reasonForWarmth).toContain('Warm');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle leads with no intent signals
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle leads with no intent signals', () => {
  it('reason includes only the score tier and score value when no signals', async () => {
    const lead = makeLead({ fitScore: 75, intentSignals: [] });
    const client = makeMockClient([makePaginatedLeads([lead])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.leads[0].reasonForWarmth).toContain('75');
    expect(result.leads[0].reasonForWarmth).toContain('Warm');
  });

  it('notes "No specific intent signals recorded" when signals array is empty', async () => {
    const lead = makeLead({ fitScore: 75, intentSignals: [] });
    const client = makeMockClient([makePaginatedLeads([lead])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.leads[0].reasonForWarmth).toContain('No specific intent signals recorded');
  });

  it('handles undefined intentSignals gracefully', async () => {
    const lead = makeLead({ fitScore: 75, intentSignals: undefined });
    const client = makeMockClient([makePaginatedLeads([lead])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.leads[0].reasonForWarmth).toContain('No specific intent signals recorded');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle zero matching leads
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle zero matching leads', () => {
  it('outputs "No warm leads found matching your criteria" when no leads match', async () => {
    const client = makeMockClient([makePaginatedLeads([], { total: 0 })]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.reportText).toContain('No warm leads found matching your criteria');
  });

  it('returns an empty leads array', async () => {
    const client = makeMockClient([makePaginatedLeads([], { total: 0 })]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.leads).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('does not error when no leads match', async () => {
    const client = makeMockClient([makePaginatedLeads([], { total: 0 })]);
    await expect(buildWarmLeadList(undefined, { _client: client })).resolves.not.toThrow();
  });

  it('returns empty byTier when no leads match', async () => {
    const client = makeMockClient([makePaginatedLeads([], { total: 0 })]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.byTier.hot).toHaveLength(0);
    expect(result.byTier.warm).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle API authentication failure
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle API authentication failure', () => {
  it('throws AuthError when API key is invalid', async () => {
    const client = makeMockClientThrowing(new AuthError());
    await expect(buildWarmLeadList(undefined, { _client: client })).rejects.toThrow(AuthError);
  });

  it('does not output a partial list on AuthError', async () => {
    const client = makeMockClientThrowing(new AuthError());
    let result;
    try {
      result = await buildWarmLeadList(undefined, { _client: client });
    } catch {
      // expected
    }
    expect(result).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Output format
// ──────────────────────────────────────────────────────────────────────────────

describe('Output format', () => {
  it('reportText contains "Warm Lead List" header', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead()])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.reportText).toContain('Warm Lead List');
  });

  it('reportText shows filter summary with score threshold', async () => {
    const client = makeMockClient([makePaginatedLeads([makeLead()])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.reportText).toContain('score');
    // reportText should contain the configured score threshold (50 default or env override)
    expect(result.reportText).toMatch(/score.*\d+/);
  });

  it('reportText shows found count', async () => {
    const leads = [makeLead({ id: 'a', fitScore: 85 }), makeLead({ id: 'b', fitScore: 65 })];
    const client = makeMockClient([makePaginatedLeads(leads)]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.reportText).toContain('2');
  });

  it('reportText includes Hot section for leads with score >= 80', async () => {
    const lead = makeLead({ fitScore: 85 });
    const client = makeMockClient([makePaginatedLeads([lead])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.reportText).toContain('Hot');
  });

  it('reportText includes Warm section for leads with score 50-79', async () => {
    const lead = makeLead({ fitScore: 65 });
    const client = makeMockClient([makePaginatedLeads([lead])]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.reportText).toContain('Warm');
  });

  it('byTier correctly separates hot and warm leads', async () => {
    const leads = [
      makeLead({ id: 'a', fitScore: 85 }),
      makeLead({ id: 'b', fitScore: 65 }),
      makeLead({ id: 'c', fitScore: 92 }),
    ];
    const client = makeMockClient([makePaginatedLeads(leads)]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.byTier.hot).toHaveLength(2);
    expect(result.byTier.warm).toHaveLength(1);
  });

  it('total reflects total number of leads returned', async () => {
    const leads = [makeLead({ id: 'a' }), makeLead({ id: 'b' })];
    const client = makeMockClient([makePaginatedLeads(leads)]);
    const result = await buildWarmLeadList(undefined, { _client: client });
    expect(result.total).toBe(2);
  });
});
