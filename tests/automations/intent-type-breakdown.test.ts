import { describe, it, expect, vi } from 'vitest';
import { analyzeIntentTypes } from '../../src/automations/intent-type-breakdown.js';
import { AuthError } from '../../src/api/errors.js';
import type { Campaign, Lead, PaginatedLeads } from '../../src/api/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1',
    firstName: 'Jane',
    lastName: 'Doe',
    profileUrl: 'https://linkedin.com/in/jane-doe',
    ...overrides,
  };
}

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'campaign-1',
    name: 'Q1 Outreach',
    status: 'active',
    ...overrides,
  };
}

function paginatedWith(leads: Lead[], total?: number): PaginatedLeads {
  return { leads, total: total ?? leads.length, page: 1, pageSize: 250 };
}

type MockClient = {
  getIntentTypeCounts: ReturnType<typeof vi.fn>;
  searchLeads: ReturnType<typeof vi.fn>;
  getCampaigns: ReturnType<typeof vi.fn>;
};

function makeMockClient(
  overrides: Partial<{
    getIntentTypeCounts: () => Promise<Record<string, number>>;
    searchLeads: () => Promise<PaginatedLeads>;
    getCampaigns: () => Promise<Campaign[]>;
  }> = {},
): MockClient {
  return {
    getIntentTypeCounts: overrides.getIntentTypeCounts
      ? vi.fn().mockImplementation(overrides.getIntentTypeCounts)
      : vi.fn().mockResolvedValue({}),
    searchLeads: overrides.searchLeads
      ? vi.fn().mockImplementation(overrides.searchLeads)
      : vi.fn().mockResolvedValue(paginatedWith([])),
    getCampaigns: overrides.getCampaigns
      ? vi.fn().mockImplementation(overrides.getCampaigns)
      : vi.fn().mockResolvedValue([]),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate intent type breakdown report
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate intent type breakdown report', () => {
  it('calls getIntentTypeCounts, searchLeads, and getCampaigns', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 2, fundraising: 1 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 70 }),
          makeLead({ id: 'l2', intentType: 'hiring', fitScore: 80 }),
          makeLead({ id: 'l3', intentType: 'fundraising', fitScore: 40 }),
        ]),
      getCampaigns: async () => [makeCampaign()],
    });

    await analyzeIntentTypes({ _client: client });

    expect(client.getIntentTypeCounts).toHaveBeenCalled();
    expect(client.searchLeads).toHaveBeenCalled();
    expect(client.getCampaigns).toHaveBeenCalled();
  });

  it('groups contacts by intent type and computes contact count per type', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 3, expansion: 1 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 70 }),
          makeLead({ id: 'l2', intentType: 'hiring', fitScore: 80 }),
          makeLead({ id: 'l3', intentType: 'hiring', fitScore: 60 }),
          makeLead({ id: 'l4', intentType: 'expansion', fitScore: 50 }),
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    const hiring = report.types.find((t) => t.intentType === 'hiring');
    const expansion = report.types.find((t) => t.intentType === 'expansion');
    expect(hiring?.contactCount).toBe(3);
    expect(expansion?.contactCount).toBe(1);
  });

  it('computes average fit score per intent type', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 2 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 60 }),
          makeLead({ id: 'l2', intentType: 'hiring', fitScore: 80 }),
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    const hiring = report.types.find((t) => t.intentType === 'hiring');
    expect(hiring?.averageFitScore).toBe(70);
  });

  it('computes score tier distribution per intent type', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 4 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 90 }),  // hot
          makeLead({ id: 'l2', intentType: 'hiring', fitScore: 60 }),  // warm
          makeLead({ id: 'l3', intentType: 'hiring', fitScore: 30 }),  // cool
          makeLead({ id: 'l4', intentType: 'hiring' }),                 // unscored
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    const hiring = report.types.find((t) => t.intentType === 'hiring');
    expect(hiring?.scoreTiers).toEqual({ hot: 1, warm: 1, cool: 1, cold: 0, unscored: 1 });
  });

  it('includes generatedAt ISO timestamp', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 1 }),
      searchLeads: async () =>
        paginatedWith([makeLead({ id: 'l1', intentType: 'hiring', fitScore: 70 })]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('includes totalContacts and totalTypes in the report', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 2, expansion: 1 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 70 }),
          makeLead({ id: 'l2', intentType: 'hiring', fitScore: 80 }),
          makeLead({ id: 'l3', intentType: 'expansion', fitScore: 50 }),
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    expect(report.totalContacts).toBe(3);
    expect(report.totalTypes).toBe(2);
  });

  it('returns structured reportText', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 2, fundraising: 1 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 75 }),
          makeLead({ id: 'l2', intentType: 'hiring', fitScore: 85 }),
          makeLead({ id: 'l3', intentType: 'fundraising', fitScore: 40 }),
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    expect(typeof report.reportText).toBe('string');
    expect(report.reportText).toMatch(/Intent Type Breakdown/i);
    expect(report.reportText).toMatch(/hiring/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Correlate intent types with campaign reply rates
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Correlate intent types with campaign reply rates', () => {
  it('ranks intent types by average fit score (highest first) as topType and bottomType', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 2, expansion: 2, fundraising: 2 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 80 }),
          makeLead({ id: 'l2', intentType: 'hiring', fitScore: 90 }),    // avg 85
          makeLead({ id: 'l3', intentType: 'expansion', fitScore: 50 }),
          makeLead({ id: 'l4', intentType: 'expansion', fitScore: 60 }), // avg 55
          makeLead({ id: 'l5', intentType: 'fundraising', fitScore: 20 }),
          makeLead({ id: 'l6', intentType: 'fundraising', fitScore: 30 }), // avg 25
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    expect(report.topType?.intentType).toBe('hiring');
    expect(report.bottomType?.intentType).toBe('fundraising');
  });

  it('includes recommendation for top type in report text', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 2, expansion: 2 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 80 }),
          makeLead({ id: 'l2', intentType: 'hiring', fitScore: 90 }),
          makeLead({ id: 'l3', intentType: 'expansion', fitScore: 40 }),
          makeLead({ id: 'l4', intentType: 'expansion', fitScore: 50 }),
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    expect(report.reportText).toMatch(/Focus discovery on 'hiring'/i);
    expect(report.reportText).toMatch(/highest average fit score/i);
  });

  it('mentions bottomType in report text recommendation', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 2, expansion: 2 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 80 }),
          makeLead({ id: 'l2', intentType: 'hiring', fitScore: 90 }),
          makeLead({ id: 'l3', intentType: 'expansion', fitScore: 20 }),
          makeLead({ id: 'l4', intentType: 'expansion', fitScore: 30 }),
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    expect(report.reportText).toMatch(/Consider deprioritizing 'expansion'/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Identify noise intent types
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Identify noise intent types', () => {
  it('flags signalQuality as "low" when average fit score is below 30', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ noisetype: 2 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'noisetype', fitScore: 10 }),
          makeLead({ id: 'l2', intentType: 'noisetype', fitScore: 20 }),
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    const noiseType = report.types.find((t) => t.intentType === 'noisetype');
    expect(noiseType?.signalQuality).toBe('low');
  });

  it('flags signalQuality as "needs_scoring" when all contacts are unscored', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ unscoredtype: 2 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'unscoredtype' }), // no fitScore
          makeLead({ id: 'l2', intentType: 'unscoredtype' }), // no fitScore
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    const unscoredType = report.types.find((t) => t.intentType === 'unscoredtype');
    expect(unscoredType?.signalQuality).toBe('needs_scoring');
    expect(unscoredType?.averageFitScore).toBeNull();
  });

  it('flags signalQuality as "high" when average fit score is 60 or above', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hightype: 1 }),
      searchLeads: async () =>
        paginatedWith([makeLead({ id: 'l1', intentType: 'hightype', fitScore: 75 })]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    const highType = report.types.find((t) => t.intentType === 'hightype');
    expect(highType?.signalQuality).toBe('high');
  });

  it('flags signalQuality as "medium" when average fit score is 30–59', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ medtype: 1 }),
      searchLeads: async () =>
        paginatedWith([makeLead({ id: 'l1', intentType: 'medtype', fitScore: 45 })]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    const medType = report.types.find((t) => t.intentType === 'medtype');
    expect(medType?.signalQuality).toBe('medium');
  });

  it('report text includes Signal Quality section', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 1, noisetype: 1 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 75 }),
          makeLead({ id: 'l2', intentType: 'noisetype', fitScore: 10 }),
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    expect(report.reportText).toMatch(/Signal Quality/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle single intent type
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle single intent type', () => {
  it('outputs metrics for the single type', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 3 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 70 }),
          makeLead({ id: 'l2', intentType: 'hiring', fitScore: 80 }),
          makeLead({ id: 'l3', intentType: 'hiring', fitScore: 60 }),
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    expect(report.types).toHaveLength(1);
    expect(report.types[0].intentType).toBe('hiring');
    expect(report.types[0].contactCount).toBe(3);
  });

  it('skips comparative analysis (topType and bottomType are null)', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 2 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 70 }),
          makeLead({ id: 'l2', intentType: 'hiring', fitScore: 80 }),
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    expect(report.topType).toBeNull();
    expect(report.bottomType).toBeNull();
  });

  it('notes "Only one intent type in pipeline — consider diversifying discovery"', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 2 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 70 }),
          makeLead({ id: 'l2', intentType: 'hiring', fitScore: 80 }),
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    expect(report.reportText).toMatch(/Only one intent type in pipeline/i);
    expect(report.reportText).toMatch(/consider diversifying discovery/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle no intent data
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle no intent data', () => {
  it('outputs the no-intent-data message when getIntentTypeCounts returns {}', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({}),
      searchLeads: async () => paginatedWith([makeLead({ id: 'l1', fitScore: 70 })]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    expect(report.reportText).toMatch(
      /No intent data available — enrich contacts with intent types first/i,
    );
  });

  it('returns a report with empty type breakdown', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({}),
    });

    const report = await analyzeIntentTypes({ _client: client });

    expect(report.types).toEqual([]);
    expect(report.totalTypes).toBe(0);
    expect(report.topType).toBeNull();
    expect(report.bottomType).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle contacts with no intent type
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle contacts with no intent type', () => {
  it('groups contacts without intentType under "unclassified"', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 1 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 70 }),
          makeLead({ id: 'l2' }), // no intentType
          makeLead({ id: 'l3', fitScore: 50 }), // no intentType
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    const unclassified = report.types.find((t) => t.intentType === 'unclassified');
    expect(unclassified).toBeDefined();
    expect(unclassified?.contactCount).toBe(2);
  });

  it('unclassified has its own metrics in the breakdown', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 1 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 70 }),
          makeLead({ id: 'l2', fitScore: 50 }), // no intentType → unclassified
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    const unclassified = report.types.find((t) => t.intentType === 'unclassified');
    expect(unclassified?.averageFitScore).toBe(50);
    expect(unclassified?.scoreTiers.warm).toBe(1);
  });

  it('unclassified is not included in topType or bottomType', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 1, expansion: 1 }),
      searchLeads: async () =>
        paginatedWith([
          makeLead({ id: 'l1', intentType: 'hiring', fitScore: 90 }),
          makeLead({ id: 'l2', intentType: 'expansion', fitScore: 30 }),
          makeLead({ id: 'l3', fitScore: 10 }), // unclassified with low score
        ]),
    });

    const report = await analyzeIntentTypes({ _client: client });

    expect(report.topType?.intentType).toBe('hiring');
    expect(report.bottomType?.intentType).toBe('expansion');
    expect(report.topType?.intentType).not.toBe('unclassified');
    expect(report.bottomType?.intentType).not.toBe('unclassified');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle API authentication failure
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle API authentication failure', () => {
  it('throws AuthError when getIntentTypeCounts fails with auth error', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => {
        throw new AuthError();
      },
    });

    await expect(analyzeIntentTypes({ _client: client })).rejects.toThrow(AuthError);
  });

  it('throws AuthError when searchLeads fails with auth error', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 1 }),
      searchLeads: async () => {
        throw new AuthError();
      },
    });

    await expect(analyzeIntentTypes({ _client: client })).rejects.toThrow(AuthError);
  });

  it('does not return a partial report on auth failure', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => {
        throw new AuthError();
      },
    });

    let result: unknown;
    try {
      result = await analyzeIntentTypes({ _client: client });
    } catch {
      result = undefined;
    }

    expect(result).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Large number of intent types
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Large number of intent types', () => {
  function makeTypeLeads(intentType: string, count: number, baseScore: number): Lead[] {
    return Array.from({ length: count }, (_, i) =>
      makeLead({ id: `${intentType}-${i}`, intentType, fitScore: baseScore }),
    );
  }

  it('shows the top 10 by contact count in the report text', async () => {
    // 12 types, various counts
    const intentTypeCounts: Record<string, number> = {};
    const allLeads: Lead[] = [];
    for (let i = 1; i <= 12; i++) {
      const type = `type-${i.toString().padStart(2, '0')}`;
      const count = 13 - i; // type-01 has 12 contacts, type-12 has 1
      intentTypeCounts[type] = count;
      allLeads.push(...makeTypeLeads(type, count, 50));
    }

    const client = makeMockClient({
      getIntentTypeCounts: async () => intentTypeCounts,
      searchLeads: async () => paginatedWith(allLeads),
    });

    const report = await analyzeIntentTypes({ _client: client });

    // Top 10 by contact count: type-01..type-10 (counts 12,11,...3)
    expect(report.reportText).toMatch(/type-01/);
    expect(report.reportText).toMatch(/type-10/);
    // type-11 and type-12 should be summarized, not listed individually
    expect(report.reportText).toMatch(/and 2 more type/i);
  });

  it('includes all types in the types array (not capped at 10)', async () => {
    const intentTypeCounts: Record<string, number> = {};
    const allLeads: Lead[] = [];
    for (let i = 1; i <= 12; i++) {
      const type = `type-${i.toString().padStart(2, '0')}`;
      intentTypeCounts[type] = 5;
      allLeads.push(...makeTypeLeads(type, 5, 50));
    }

    const client = makeMockClient({
      getIntentTypeCounts: async () => intentTypeCounts,
      searchLeads: async () => paginatedWith(allLeads),
    });

    const report = await analyzeIntentTypes({ _client: client });

    expect(report.types.length).toBe(12);
    expect(report.totalTypes).toBe(12);
  });

  it('summarizes remaining types as "and {n} more types with {total} contacts"', async () => {
    const intentTypeCounts: Record<string, number> = {};
    const allLeads: Lead[] = [];
    // 11 types: types 1-10 have 10 contacts each, type-11 has 3
    for (let i = 1; i <= 10; i++) {
      const type = `type-${i.toString().padStart(2, '0')}`;
      intentTypeCounts[type] = 10;
      allLeads.push(...makeTypeLeads(type, 10, 50));
    }
    intentTypeCounts['type-11'] = 3;
    allLeads.push(...makeTypeLeads('type-11', 3, 50));

    const client = makeMockClient({
      getIntentTypeCounts: async () => intentTypeCounts,
      searchLeads: async () => paginatedWith(allLeads),
    });

    const report = await analyzeIntentTypes({ _client: client });

    expect(report.reportText).toMatch(/and 1 more type.*3 contact/i);
  });
});
