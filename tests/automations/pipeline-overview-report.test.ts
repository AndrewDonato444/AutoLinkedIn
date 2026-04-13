import { describe, it, expect, vi } from 'vitest';
import { generatePipelineOverview } from '../../src/automations/pipeline-overview-report.js';
import { AuthError, TimeoutError } from '../../src/api/errors.js';
import type { GojiBerryClient } from '../../src/api/gojiberry-client.js';
import type { Campaign, Lead, List, PaginatedLeads } from '../../src/api/types.js';

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

function makeList(overrides: Partial<List> = {}): List {
  return {
    id: 'list-1',
    name: 'ICP Prospects',
    leadCount: 10,
    ...overrides,
  };
}

function paginatedWith(leads: Lead[], total?: number): PaginatedLeads {
  return { leads, total: total ?? leads.length, page: 1, pageSize: 250 };
}

type MockClient = {
  searchLeads: ReturnType<typeof vi.fn>;
  getIntentTypeCounts: ReturnType<typeof vi.fn>;
  getCampaigns: ReturnType<typeof vi.fn>;
  getLists: ReturnType<typeof vi.fn>;
};

function makeMockClient(overrides: Partial<{
  searchLeads: () => Promise<PaginatedLeads>;
  getIntentTypeCounts: () => Promise<Record<string, number>>;
  getCampaigns: () => Promise<Campaign[]>;
  getLists: () => Promise<List[]>;
}> = {}): MockClient {
  return {
    searchLeads: overrides.searchLeads
      ? vi.fn().mockImplementation(overrides.searchLeads)
      : vi.fn().mockResolvedValue(paginatedWith([])),
    getIntentTypeCounts: overrides.getIntentTypeCounts
      ? vi.fn().mockImplementation(overrides.getIntentTypeCounts)
      : vi.fn().mockResolvedValue({}),
    getCampaigns: overrides.getCampaigns
      ? vi.fn().mockImplementation(overrides.getCampaigns)
      : vi.fn().mockResolvedValue([]),
    getLists: overrides.getLists
      ? vi.fn().mockImplementation(overrides.getLists)
      : vi.fn().mockResolvedValue([]),
  };
}

function asClient(mock: MockClient): GojiBerryClient {
  return mock as unknown as GojiBerryClient;
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate a complete pipeline overview
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate a complete pipeline overview', () => {
  it('includes total contact count', async () => {
    const leads = [
      makeLead({ id: 'l1', fitScore: 85 }),
      makeLead({ id: 'l2', fitScore: 60 }),
      makeLead({ id: 'l3', fitScore: 30 }),
    ];
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
      getIntentTypeCounts: async () => ({ hiring: 2, fundraising: 1 }),
      getCampaigns: async () => [makeCampaign()],
      getLists: async () => [makeList()],
    });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.contacts.total).toBe(3);
  });

  it('includes breakdown of contacts by intent type', async () => {
    const client = makeMockClient({
      searchLeads: async () => paginatedWith([makeLead({ id: 'l1' })]),
      getIntentTypeCounts: async () => ({ hiring: 5, fundraising: 2, expansion: 1 }),
    });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.contacts.byIntentType).toEqual({ hiring: 5, fundraising: 2, expansion: 1 });
  });

  it('includes total campaign count with status breakdown', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', status: 'active' }),
      makeCampaign({ id: 'c2', status: 'active' }),
      makeCampaign({ id: 'c3', status: 'completed' }),
    ];
    const client = makeMockClient({
      getCampaigns: async () => campaigns,
    });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.campaigns.total).toBe(3);
    expect(report.campaigns.byStatus).toEqual({ active: 2, completed: 1 });
  });

  it('includes a plain-English summary paragraph', async () => {
    const leads = [makeLead({ id: 'l1', fitScore: 85 })];
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
      getIntentTypeCounts: async () => ({ hiring: 1 }),
      getCampaigns: async () => [makeCampaign({ status: 'active' })],
    });

    const report = await generatePipelineOverview(asClient(client));

    expect(typeof report.summary).toBe('string');
    expect(report.summary.length).toBeGreaterThan(10);
    expect(report.summary).toMatch(/pipeline/i);
  });

  it('includes a generatedAt ISO timestamp', async () => {
    const client = makeMockClient();
    const report = await generatePipelineOverview(asClient(client));

    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate report with score tier breakdown
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate report with score tier breakdown', () => {
  it('groups contacts into Hot (80-100), Warm (50-79), Cool (20-49), Cold (0-19)', async () => {
    const leads = [
      makeLead({ id: 'l1', fitScore: 95 }),   // hot
      makeLead({ id: 'l2', fitScore: 80 }),   // hot
      makeLead({ id: 'l3', fitScore: 75 }),   // warm
      makeLead({ id: 'l4', fitScore: 50 }),   // warm
      makeLead({ id: 'l5', fitScore: 45 }),   // cool
      makeLead({ id: 'l6', fitScore: 20 }),   // cool
      makeLead({ id: 'l7', fitScore: 15 }),   // cold
      makeLead({ id: 'l8', fitScore: 0 }),    // cold
      makeLead({ id: 'l9' }),                 // unscored (no fitScore)
    ];
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
    });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.contacts.byScoreTier).toEqual({
      hot: 2,
      warm: 2,
      cool: 2,
      cold: 2,
      unscored: 1,
    });
  });

  it('counts contacts with no fitScore as unscored', async () => {
    const leads = [
      makeLead({ id: 'l1', fitScore: undefined }),
      makeLead({ id: 'l2' }), // no fitScore key at all
    ];
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
    });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.contacts.byScoreTier.unscored).toBe(2);
    expect(report.contacts.byScoreTier.hot).toBe(0);
  });

  it('score tier summary mentions hot and warm counts', async () => {
    const leads = [
      makeLead({ id: 'l1', fitScore: 90 }),
      makeLead({ id: 'l2', fitScore: 65 }),
    ];
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
    });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.summary).toMatch(/1 hot/);
    expect(report.summary).toMatch(/1 warm/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate report with campaign metrics
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate report with campaign metrics', () => {
  it('includes aggregate campaign metrics across all campaigns', async () => {
    const campaigns = [
      makeCampaign({
        id: 'c1',
        status: 'active',
        metrics: { sent: 300, opened: 80, replied: 40, converted: 10 },
      }),
      makeCampaign({
        id: 'c2',
        status: 'completed',
        metrics: { sent: 200, opened: 50, replied: 20, converted: 5 },
      }),
    ];
    const client = makeMockClient({ getCampaigns: async () => campaigns });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.campaigns.metrics).toEqual({
      totalSent: 500,
      totalOpened: 130,
      totalReplied: 60,
      totalConverted: 15,
    });
  });

  it('includes per-campaign status breakdown', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', status: 'active' }),
      makeCampaign({ id: 'c2', status: 'paused' }),
      makeCampaign({ id: 'c3', status: 'completed' }),
      makeCampaign({ id: 'c4', status: 'draft' }),
    ];
    const client = makeMockClient({ getCampaigns: async () => campaigns });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.campaigns.byStatus).toEqual({
      active: 1,
      paused: 1,
      completed: 1,
      draft: 1,
    });
  });

  it('includes reply rate in summary when messages have been sent', async () => {
    const campaigns = [
      makeCampaign({
        id: 'c1',
        status: 'active',
        metrics: { sent: 100, opened: 30, replied: 12, converted: 3 },
      }),
    ];
    const client = makeMockClient({ getCampaigns: async () => campaigns });

    const report = await generatePipelineOverview(asClient(client));

    // 12 / 100 * 100 = 12% reply rate
    expect(report.summary).toMatch(/12%/);
    expect(report.summary).toMatch(/reply rate/i);
  });

  it('handles campaigns without metrics (no metrics key)', async () => {
    const campaigns = [makeCampaign({ id: 'c1', status: 'draft' })]; // no metrics
    const client = makeMockClient({ getCampaigns: async () => campaigns });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.campaigns.metrics).toEqual({
      totalSent: 0,
      totalOpened: 0,
      totalReplied: 0,
      totalConverted: 0,
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle empty pipeline gracefully
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle empty pipeline gracefully', () => {
  it('report indicates zero contacts', async () => {
    const client = makeMockClient();
    const report = await generatePipelineOverview(asClient(client));

    expect(report.contacts.total).toBe(0);
    expect(report.contacts.byScoreTier).toEqual({
      hot: 0,
      warm: 0,
      cool: 0,
      cold: 0,
      unscored: 0,
    });
  });

  it('report indicates zero campaigns', async () => {
    const client = makeMockClient();
    const report = await generatePipelineOverview(asClient(client));

    expect(report.campaigns.total).toBe(0);
    expect(report.campaigns.byStatus).toEqual({});
    expect(report.campaigns.metrics).toEqual({
      totalSent: 0,
      totalOpened: 0,
      totalReplied: 0,
      totalConverted: 0,
    });
  });

  it('summary describes an empty pipeline (mentions zero or no campaigns)', async () => {
    const client = makeMockClient();
    const report = await generatePipelineOverview(asClient(client));

    // Must mention the zero contact count and indicate no campaigns
    expect(report.summary).toMatch(/0 contact/i);
    expect(report.summary).toMatch(/no.*campaign|0.*campaign/i);
  });

  it('lists section reflects no lists', async () => {
    const client = makeMockClient();
    const report = await generatePipelineOverview(asClient(client));

    expect(report.lists.total).toBe(0);
    expect(report.lists.totalLeadsInLists).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle partial data (contacts but no campaigns)
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle partial data (contacts but no campaigns)', () => {
  it('includes contact data normally when campaigns are absent', async () => {
    const leads = [
      makeLead({ id: 'l1', fitScore: 85 }),
      makeLead({ id: 'l2', fitScore: 60 }),
    ];
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
      getIntentTypeCounts: async () => ({ hiring: 2 }),
      getCampaigns: async () => [],
    });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.contacts.total).toBe(2);
    expect(report.contacts.byScoreTier.hot).toBe(1);
    expect(report.contacts.byScoreTier.warm).toBe(1);
    expect(report.contacts.byIntentType).toEqual({ hiring: 2 });
  });

  it('campaign section indicates no active campaigns', async () => {
    const leads = [makeLead({ id: 'l1', fitScore: 75 })];
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
      getCampaigns: async () => [],
    });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.campaigns.total).toBe(0);
    expect(report.summary).toMatch(/no.*campaign/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle API unreachable
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle API unreachable', () => {
  it('throws when the API cannot be reached (network error)', async () => {
    const networkError = new Error('fetch failed');
    const client = makeMockClient({
      searchLeads: async () => { throw networkError; },
    });

    await expect(generatePipelineOverview(asClient(client))).rejects.toThrow('fetch failed');
  });

  it('propagates TimeoutError when API times out', async () => {
    const client = makeMockClient({
      searchLeads: async () => { throw new TimeoutError(); },
    });

    await expect(generatePipelineOverview(asClient(client))).rejects.toThrow(TimeoutError);
  });

  it('throws an error (not silently returning a partial report)', async () => {
    const client = makeMockClient({
      searchLeads: async () => { throw new Error('ECONNREFUSED'); },
    });

    await expect(generatePipelineOverview(asClient(client))).rejects.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle API authentication failure
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle API authentication failure', () => {
  it('throws AuthError when the API key is invalid', async () => {
    const client = makeMockClient({
      searchLeads: async () => { throw new AuthError(); },
    });

    await expect(generatePipelineOverview(asClient(client))).rejects.toThrow(AuthError);
  });

  it('AuthError message indicates the key is invalid or expired', async () => {
    const client = makeMockClient({
      getCampaigns: async () => { throw new AuthError(); },
    });

    await expect(generatePipelineOverview(asClient(client))).rejects.toThrow(
      'GojiBerry API key is invalid or expired',
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Lists data
// ──────────────────────────────────────────────────────────────────────────────

describe('Lists section', () => {
  it('includes total list count and total leads across all lists', async () => {
    const lists = [
      makeList({ id: 'list-1', leadCount: 15 }),
      makeList({ id: 'list-2', leadCount: 30 }),
      makeList({ id: 'list-3', leadCount: 5 }),
    ];
    const client = makeMockClient({ getLists: async () => lists });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.lists.total).toBe(3);
    expect(report.lists.totalLeadsInLists).toBe(50);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Summary generation rules
// ──────────────────────────────────────────────────────────────────────────────

describe('Summary generation rules', () => {
  it('mentions the top intent type by name', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({ hiring: 38, fundraising: 10 }),
    });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.summary).toMatch(/hiring/i);
  });

  it('says "no intent data" when byIntentType is empty', async () => {
    const client = makeMockClient({
      getIntentTypeCounts: async () => ({}),
    });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.summary).toMatch(/no intent data/i);
  });

  it('does not include reply rate when no messages have been sent', async () => {
    const client = makeMockClient({
      getCampaigns: async () => [makeCampaign({ id: 'c1', status: 'draft' })],
    });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.summary).not.toMatch(/reply rate/i);
  });

  it('includes contact total in summary', async () => {
    const leads = Array.from({ length: 5 }, (_, i) =>
      makeLead({ id: `l${i}`, fitScore: 60 + i }),
    );
    const client = makeMockClient({
      searchLeads: async () => paginatedWith(leads),
    });

    const report = await generatePipelineOverview(asClient(client));

    expect(report.summary).toMatch(/5 contact/i);
  });
});
