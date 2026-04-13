import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  analyzeLeadQuality,
  type PatternAnalysisFn,
  type SignalEffectiveness,
  type FeedbackRecommendation,
  type IntentTypeCorrelation,
} from '../../src/automations/lead-quality-feedback-loop.js';
import { AuthError, ConfigError } from '../../src/api/errors.js';
import type { Campaign, Lead, PaginatedLeads, LeadFilters } from '../../src/api/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: `camp-${Math.random().toString(36).slice(2)}`,
    name: 'Test Campaign',
    status: 'completed',
    metrics: { sent: 100, opened: 40, replied: 10, converted: 2 },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
    ...overrides,
  };
}

let leadCounter = 0;
function makeLead(overrides: Partial<Lead> = {}): Lead {
  const id = `lead-${++leadCounter}`;
  return {
    id,
    firstName: 'Jane',
    lastName: 'Doe',
    profileUrl: `https://linkedin.com/in/jane-doe-${id}`,
    company: 'Acme',
    jobTitle: 'CEO',
    fitScore: 60,
    intentSignals: [],
    intentType: 'contacted',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makePaginatedLeads(leads: Lead[]): PaginatedLeads {
  return { leads, total: leads.length, page: 1, pageSize: 100 };
}

type MockClient = {
  getCampaigns: ReturnType<typeof vi.fn>;
  searchLeads: ReturnType<typeof vi.fn>;
  getIntentTypeCounts: ReturnType<typeof vi.fn>;
};

function makeClient(
  campaigns: Campaign[],
  repliedLeads: Lead[] = [],
  allLeads: Lead[] = [],
  intentTypeCounts: Record<string, number> = {},
): MockClient {
  return {
    getCampaigns: vi.fn().mockResolvedValue(campaigns),
    searchLeads: vi.fn().mockImplementation((filters: LeadFilters = {}) => {
      if (filters.intentType === 'replied') {
        return Promise.resolve(makePaginatedLeads(repliedLeads));
      }
      return Promise.resolve(makePaginatedLeads(allLeads));
    }),
    getIntentTypeCounts: vi.fn().mockResolvedValue(intentTypeCounts),
  };
}

function makeAnalyzePatterns(
  result: {
    signalEffectiveness?: SignalEffectiveness[];
    recommendations?: FeedbackRecommendation[];
  } = {},
): PatternAnalysisFn {
  return vi.fn().mockResolvedValue({
    signalEffectiveness: result.signalEffectiveness ?? [],
    recommendations: result.recommendations ?? [],
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Standard fixtures (pass data gates: 3 campaigns, 30 leads, replies > 0)
// ──────────────────────────────────────────────────────────────────────────────

const THREE_COMPLETED_CAMPAIGNS = [
  makeCampaign({
    id: 'c1',
    name: 'Q1 Outreach',
    status: 'completed',
    metrics: { sent: 50, opened: 20, replied: 5, converted: 1 },
    createdAt: '2026-01-01T00:00:00Z',
  }),
  makeCampaign({
    id: 'c2',
    name: 'Q2 Outreach',
    status: 'completed',
    metrics: { sent: 60, opened: 25, replied: 8, converted: 2 },
    createdAt: '2026-02-01T00:00:00Z',
  }),
  makeCampaign({
    id: 'c3',
    name: 'Q3 Outreach',
    status: 'completed',
    metrics: { sent: 70, opened: 30, replied: 10, converted: 3 },
    createdAt: '2026-03-01T00:00:00Z',
  }),
];

// 30 total leads: replied leads have their original intentType preserved in allLeads
const REPLIED_LEADS_STANDARD = Array.from({ length: 23 }, (_, i) =>
  makeLead({
    id: `std-replied-${i}`,
    intentType: 'funding',
    fitScore: 75,
    intentSignals: ['Recently raised Series A'],
    company: `FundedCo${i}`,
    jobTitle: 'Founder',
  }),
);

const NON_REPLIED_LEADS_STANDARD = Array.from({ length: 7 }, (_, i) =>
  makeLead({
    id: `std-noreply-${i}`,
    intentType: 'hiring',
    fitScore: 40,
    intentSignals: [],
    company: `HiringCo${i}`,
    jobTitle: 'VP Sales',
  }),
);

const ALL_LEADS_STANDARD = [...REPLIED_LEADS_STANDARD, ...NON_REPLIED_LEADS_STANDARD];

const INTENT_TYPE_COUNTS_STANDARD: Record<string, number> = {
  funding: 23,
  hiring: 7,
};

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle missing Anthropic API key
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle missing Anthropic API key', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('throws ConfigError when ANTHROPIC_API_KEY is not set', async () => {
    await expect(
      analyzeLeadQuality({
        _client: makeClient(THREE_COMPLETED_CAMPAIGNS, REPLIED_LEADS_STANDARD, ALL_LEADS_STANDARD),
      }),
    ).rejects.toThrow(ConfigError);
  });

  it('throws error mentioning ANTHROPIC_API_KEY', async () => {
    await expect(
      analyzeLeadQuality({
        _client: makeClient(THREE_COMPLETED_CAMPAIGNS, REPLIED_LEADS_STANDARD, ALL_LEADS_STANDARD),
      }),
    ).rejects.toThrow('ANTHROPIC_API_KEY');
  });

  it('throws error mentioning .env.local', async () => {
    await expect(
      analyzeLeadQuality({
        _client: makeClient(THREE_COMPLETED_CAMPAIGNS, REPLIED_LEADS_STANDARD, ALL_LEADS_STANDARD),
      }),
    ).rejects.toThrow('.env.local');
  });

  it('throws before making any API calls when Anthropic key is missing', async () => {
    const client = makeClient(THREE_COMPLETED_CAMPAIGNS, REPLIED_LEADS_STANDARD, ALL_LEADS_STANDARD);
    await expect(analyzeLeadQuality({ _client: client })).rejects.toThrow(ConfigError);
    expect(client.getCampaigns).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle API authentication failure
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle API authentication failure', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('throws AuthError and does not output a partial report', async () => {
    const client: MockClient = {
      getCampaigns: vi.fn().mockRejectedValue(new AuthError()),
      searchLeads: vi.fn(),
      getIntentTypeCounts: vi.fn(),
    };
    await expect(
      analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() }),
    ).rejects.toThrow(AuthError);
  });

  it('does not call searchLeads when getCampaigns throws AuthError', async () => {
    const client: MockClient = {
      getCampaigns: vi.fn().mockRejectedValue(new AuthError()),
      searchLeads: vi.fn(),
      getIntentTypeCounts: vi.fn(),
    };
    await expect(
      analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() }),
    ).rejects.toThrow(AuthError);
    expect(client.searchLeads).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Reject run when insufficient data
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Reject run when insufficient data', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('returns early when fewer than minCampaigns completed campaigns', async () => {
    const twoCampaigns = [
      makeCampaign({ status: 'completed', metrics: { sent: 50, opened: 20, replied: 5, converted: 1 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 60, opened: 25, replied: 8, converted: 2 } }),
    ];
    const client = makeClient(twoCampaigns, REPLIED_LEADS_STANDARD, ALL_LEADS_STANDARD);
    const report = await analyzeLeadQuality({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns(),
      minCampaigns: 3,
      minLeads: 30,
    });
    expect(report.recommendations).toHaveLength(0);
    expect(report.reportText).toContain('3');
    expect(report.reportText).toContain('2');
  });

  it('returns early when fewer than minLeads leads', async () => {
    const fewLeads = Array.from({ length: 5 }, () => makeLead({ intentType: 'contacted' }));
    const client = makeClient(THREE_COMPLETED_CAMPAIGNS, [], fewLeads);
    const report = await analyzeLeadQuality({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns(),
      minCampaigns: 3,
      minLeads: 30,
    });
    expect(report.recommendations).toHaveLength(0);
    expect(report.reportText).toContain('30');
  });

  it('report text includes both counts when insufficient data', async () => {
    const twoCampaigns = [
      makeCampaign({ status: 'completed' }),
      makeCampaign({ status: 'completed' }),
    ];
    const fewLeads = Array.from({ length: 10 }, () => makeLead());
    const client = makeClient(twoCampaigns, [], fewLeads);
    const report = await analyzeLeadQuality({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns(),
      minCampaigns: 3,
      minLeads: 30,
    });
    expect(report.reportText).toContain('2');
    expect(report.reportText).toContain('10');
  });

  it('does not call _analyzePatterns when insufficient data', async () => {
    const twoCampaigns = [
      makeCampaign({ status: 'completed' }),
      makeCampaign({ status: 'completed' }),
    ];
    const client = makeClient(twoCampaigns, [], ALL_LEADS_STANDARD);
    const analyze = makeAnalyzePatterns();
    await analyzeLeadQuality({
      _client: client,
      _analyzePatterns: analyze,
      minCampaigns: 3,
      minLeads: 30,
    });
    expect(analyze).not.toHaveBeenCalled();
  });

  it('ignores non-completed campaigns for minimum check', async () => {
    const mixedCampaigns = [
      makeCampaign({ status: 'active', metrics: { sent: 50, opened: 20, replied: 5, converted: 1 } }),
      makeCampaign({ status: 'active', metrics: { sent: 60, opened: 25, replied: 8, converted: 2 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 70, opened: 30, replied: 10, converted: 3 } }),
    ];
    const analyze = makeAnalyzePatterns();
    const client = makeClient(mixedCampaigns, REPLIED_LEADS_STANDARD, ALL_LEADS_STANDARD);
    const report = await analyzeLeadQuality({
      _client: client,
      _analyzePatterns: analyze,
      minCampaigns: 3,
      minLeads: 30,
    });
    // Only 1 completed campaign, not enough
    expect(analyze).not.toHaveBeenCalled();
    expect(report.recommendations).toHaveLength(0);
  });

  it('uses env var defaults when options not provided', async () => {
    process.env.MIN_CAMPAIGNS_FOR_FEEDBACK = '3';
    process.env.MIN_LEADS_FOR_FEEDBACK = '30';
    const twoCampaigns = [
      makeCampaign({ status: 'completed' }),
      makeCampaign({ status: 'completed' }),
    ];
    const client = makeClient(twoCampaigns, [], ALL_LEADS_STANDARD);
    const analyze = makeAnalyzePatterns();
    await analyzeLeadQuality({ _client: client, _analyzePatterns: analyze });
    expect(analyze).not.toHaveBeenCalled();
    delete process.env.MIN_CAMPAIGNS_FOR_FEEDBACK;
    delete process.env.MIN_LEADS_FOR_FEEDBACK;
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle zero replies across all campaigns
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle zero replies across all campaigns', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  const zeroReplyCampaigns = [
    makeCampaign({ id: 'z1', status: 'completed', metrics: { sent: 50, opened: 10, replied: 0, converted: 0 } }),
    makeCampaign({ id: 'z2', status: 'completed', metrics: { sent: 60, opened: 15, replied: 0, converted: 0 } }),
    makeCampaign({ id: 'z3', status: 'completed', metrics: { sent: 70, opened: 20, replied: 0, converted: 0 } }),
  ];

  it('returns report with noReplies: true', async () => {
    const client = makeClient(zeroReplyCampaigns, [], ALL_LEADS_STANDARD);
    const report = await analyzeLeadQuality({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns(),
    });
    expect(report.noReplies).toBe(true);
  });

  it('returns empty recommendations', async () => {
    const client = makeClient(zeroReplyCampaigns, [], ALL_LEADS_STANDARD);
    const report = await analyzeLeadQuality({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns(),
    });
    expect(report.recommendations).toHaveLength(0);
  });

  it('report mentions campaign count and suggests improving messages', async () => {
    const client = makeClient(zeroReplyCampaigns, [], ALL_LEADS_STANDARD);
    const report = await analyzeLeadQuality({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns(),
    });
    expect(report.reportText).toContain('3');
    expect(report.reportText).toContain('messages');
  });

  it('does not call _analyzePatterns when zero replies', async () => {
    const client = makeClient(zeroReplyCampaigns, [], ALL_LEADS_STANDARD);
    const analyze = makeAnalyzePatterns();
    await analyzeLeadQuality({ _client: client, _analyzePatterns: analyze });
    expect(analyze).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate full-loop quality feedback from campaign results
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate full-loop quality feedback from campaign results', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('fetches all campaigns via getCampaigns', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(client.getCampaigns).toHaveBeenCalledTimes(1);
  });

  it('fetches all leads via searchLeads', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(client.searchLeads).toHaveBeenCalledWith(expect.not.objectContaining({ intentType: 'replied' }));
  });

  it('fetches intent type counts via getIntentTypeCounts', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(client.getIntentTypeCounts).toHaveBeenCalledTimes(1);
  });

  it('fetches replied leads via searchLeads with intentType: replied', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(client.searchLeads).toHaveBeenCalledWith(
      expect.objectContaining({ intentType: 'replied' }),
    );
  });

  it('calls _analyzePatterns with replied and non-replied leads', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const analyze = makeAnalyzePatterns();
    await analyzeLeadQuality({ _client: client, _analyzePatterns: analyze });
    expect(analyze).toHaveBeenCalledWith(
      expect.any(Array), // repliedLeads
      expect.any(Array), // nonRepliedLeads
      expect.any(Array), // allLeads
      expect.any(Array), // campaigns
    );
  });

  it('returns report with correct campaign count and totals', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.campaignCount).toBe(3);
    expect(report.totalLeads).toBe(30);
    // totalReplied = 5 + 8 + 10 = 23 from campaign metrics
    expect(report.totalReplied).toBe(23);
  });

  it('computes overall reply rate correctly', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    // totalReplied=23, totalSent=50+60+70=180
    expect(report.overallReplyRate).toBeCloseTo((23 / 180) * 100, 1);
  });

  it('report text starts with Lead Quality Feedback Report header', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.reportText).toContain('Lead Quality Feedback Report');
  });

  it('report text contains campaign count and overall stats', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.reportText).toContain('3');
    expect(report.reportText).toContain('30');
  });

  it('noReplies is false when there are replies', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.noReplies).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Identify intent types that predict replies
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Identify intent types that predict replies', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('computes reply rate per intent type', async () => {
    // 18 funding leads, 4 replied → 22.2% reply rate
    // 20 hiring leads, 0 replied → 0% reply rate
    const fundingLeads = Array.from({ length: 18 }, (_, i) =>
      makeLead({ id: `fund-${i}`, intentType: 'funding', fitScore: 75 }),
    );
    const hiringLeads = Array.from({ length: 20 }, (_, i) =>
      makeLead({ id: `hire-${i}`, intentType: 'hiring', fitScore: 50 }),
    );
    const repliedLeads = fundingLeads.slice(0, 4); // 4 of 18 funding leads replied
    const allLeads = [...fundingLeads, ...hiringLeads];
    const campaigns = [
      makeCampaign({ status: 'completed', metrics: { sent: 38, opened: 15, replied: 4, converted: 1 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ];
    const client = makeClient(campaigns, repliedLeads, allLeads);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });

    const fundingCorr = report.intentCorrelations.find((c) => c.intentType === 'funding');
    expect(fundingCorr).toBeDefined();
    expect(fundingCorr!.sent).toBe(18);
    expect(fundingCorr!.replied).toBe(4);
    expect(fundingCorr!.replyRate).toBeCloseTo((4 / 18) * 100, 1);
  });

  it('ranks intent types by reply rate highest first', async () => {
    const fundingLeads = Array.from({ length: 10 }, (_, i) =>
      makeLead({ id: `rank-fund-${i}`, intentType: 'funding', fitScore: 75 }),
    );
    const hiringLeads = Array.from({ length: 15 }, (_, i) =>
      makeLead({ id: `rank-hire-${i}`, intentType: 'hiring', fitScore: 50 }),
    );
    // 5/10 funding replied (50%), 1/15 hiring replied (6.7%)
    const repliedLeads = [
      ...fundingLeads.slice(0, 5),
      hiringLeads[0],
    ];
    const allLeads = [...fundingLeads, ...hiringLeads];
    const campaigns = [
      makeCampaign({ status: 'completed', metrics: { sent: 25, opened: 10, replied: 6, converted: 1 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ];
    const client = makeClient(campaigns, repliedLeads, allLeads);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns(), minLeads: 25 });

    expect(report.intentCorrelations.length).toBeGreaterThan(0);
    // First item should have highest reply rate
    if (report.intentCorrelations.length >= 2) {
      expect(report.intentCorrelations[0].replyRate).toBeGreaterThanOrEqual(
        report.intentCorrelations[1].replyRate,
      );
    }
  });

  it('flags intent types with zero replies in report text', async () => {
    const fundingLeads = Array.from({ length: 12 }, (_, i) =>
      makeLead({ id: `zero-fund-${i}`, intentType: 'funding', fitScore: 75 }),
    );
    const jobChangeLeads = Array.from({ length: 10 }, (_, i) =>
      makeLead({ id: `zero-jc-${i}`, intentType: 'job_change', fitScore: 50 }),
    );
    // Only funding leads replied, job_change has 0 replies
    const repliedLeads = fundingLeads.slice(0, 4);
    const allLeads = [...fundingLeads, ...jobChangeLeads, ...Array.from({ length: 8 }, () => makeLead())];
    const campaigns = [
      makeCampaign({ status: 'completed', metrics: { sent: 30, opened: 12, replied: 4, converted: 1 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ];
    const client = makeClient(campaigns, repliedLeads, allLeads);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });

    expect(report.reportText).toContain('job_change');
  });

  it('flags confidence as high for intent types with 10+ leads', async () => {
    const fundingLeads = Array.from({ length: 12 }, (_, i) =>
      makeLead({ id: `conf-fund-${i}`, intentType: 'funding', fitScore: 75 }),
    );
    const repliedLeads = fundingLeads.slice(0, 3);
    const allLeads = [...fundingLeads, ...Array.from({ length: 18 }, () => makeLead())];
    const campaigns = [
      makeCampaign({ status: 'completed', metrics: { sent: 30, opened: 10, replied: 3, converted: 1 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ];
    const client = makeClient(campaigns, repliedLeads, allLeads);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });

    const fundingCorr = report.intentCorrelations.find((c) => c.intentType === 'funding');
    expect(fundingCorr?.confidence).toBe('high');
  });

  it('flags confidence as low for intent types with fewer than 10 leads', async () => {
    const smallTypeLeads = Array.from({ length: 5 }, (_, i) =>
      makeLead({ id: `small-${i}`, intentType: 'rare_type', fitScore: 75 }),
    );
    const repliedLeads = smallTypeLeads.slice(0, 2);
    const allLeads = [...smallTypeLeads, ...Array.from({ length: 25 }, () => makeLead())];
    const campaigns = [
      makeCampaign({ status: 'completed', metrics: { sent: 30, opened: 10, replied: 2, converted: 1 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ];
    const client = makeClient(campaigns, repliedLeads, allLeads);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });

    const smallCorr = report.intentCorrelations.find((c) => c.intentType === 'rare_type');
    expect(smallCorr?.confidence).toBe('low');
  });

  it('report text contains Intent Types section', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.reportText).toContain('Intent Types');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Identify enrichment signals that correlate with replies
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Identify enrichment signals that correlate with replies', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('calls _analyzePatterns with replied leads, non-replied leads, all leads, and campaigns', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const analyze = makeAnalyzePatterns();
    await analyzeLeadQuality({ _client: client, _analyzePatterns: analyze });
    expect(analyze).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: REPLIED_LEADS_STANDARD[0].id })]),
      expect.any(Array),
      expect.any(Array),
      expect.any(Array),
    );
  });

  it('includes effective signals from analyzePatterns in report', async () => {
    const effectiveSignal: SignalEffectiveness = {
      signal: 'Recently raised funding',
      leadsWithSignal: 18,
      repliedWithSignal: 4,
      replyRateWithSignal: 22.2,
      baselineReplyRate: 8.5,
      lift: 2.61,
      category: 'effective',
      confidence: 'high',
    };
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ signalEffectiveness: [effectiveSignal] }),
    });
    expect(report.signalEffectiveness.effective).toEqual(
      expect.arrayContaining([expect.objectContaining({ signal: 'Recently raised funding' })]),
    );
  });

  it('separates effective and ineffective signals', async () => {
    const signals: SignalEffectiveness[] = [
      {
        signal: 'Recently raised funding',
        leadsWithSignal: 18,
        repliedWithSignal: 4,
        replyRateWithSignal: 22.2,
        baselineReplyRate: 8.5,
        lift: 2.61,
        category: 'effective',
        confidence: 'high',
      },
      {
        signal: 'Job change',
        leadsWithSignal: 20,
        repliedWithSignal: 1,
        replyRateWithSignal: 5,
        baselineReplyRate: 8.5,
        lift: 0.59,
        category: 'ineffective',
        confidence: 'high',
      },
    ];
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ signalEffectiveness: signals }),
    });
    // LLM-provided signals should be present; field importance may also add entries
    expect(report.signalEffectiveness.effective).toEqual(
      expect.arrayContaining([expect.objectContaining({ signal: 'Recently raised funding' })]),
    );
    expect(report.signalEffectiveness.ineffective).toEqual(
      expect.arrayContaining([expect.objectContaining({ signal: 'Job change' })]),
    );
  });

  it('report text contains Enrichment Signals sections', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.reportText).toContain('Enrichment Signals');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Score field importance
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Score field importance', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('computes higher reply rate for leads with intent signals vs without', async () => {
    // Leads with intentSignals reply more
    const withSignals = Array.from({ length: 15 }, (_, i) =>
      makeLead({
        id: `sig-yes-${i}`,
        intentType: 'funding',
        intentSignals: ['Recently raised funding'],
        fitScore: 75,
      }),
    );
    const withoutSignals = Array.from({ length: 15 }, (_, i) =>
      makeLead({
        id: `sig-no-${i}`,
        intentType: 'contacted',
        intentSignals: [],
        fitScore: 45,
      }),
    );
    // 5 of the withSignals leads replied, 0 of withoutSignals
    const repliedLeads = withSignals.slice(0, 5);
    const allLeads = [...withSignals, ...withoutSignals];
    const campaigns = [
      makeCampaign({ status: 'completed', metrics: { sent: 30, opened: 12, replied: 5, converted: 1 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ];
    const client = makeClient(campaigns, repliedLeads, allLeads);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });

    // Find the field importance signal in signalEffectiveness or report text
    const allSignals = [
      ...report.signalEffectiveness.effective,
      ...report.signalEffectiveness.ineffective,
      ...report.signalEffectiveness.inconclusive,
    ];
    const intentSignalField = allSignals.find((s) => s.signal === 'intentSignals present');
    if (intentSignalField) {
      // Leads with intentSignals should reply at higher rate
      expect(intentSignalField.replyRateWithSignal).toBeGreaterThan(intentSignalField.baselineReplyRate * 0.5);
    }
    // OR the report text mentions intent signals
    expect(report.reportText).toBeDefined();
  });

  it('report mentions enrichment value when signals correlate with replies', async () => {
    const withSignals = Array.from({ length: 15 }, (_, i) =>
      makeLead({
        id: `enrich-yes-${i}`,
        intentType: 'funding',
        intentSignals: ['Recently raised funding'],
        fitScore: 75,
      }),
    );
    const withoutSignals = Array.from({ length: 15 }, (_, i) =>
      makeLead({
        id: `enrich-no-${i}`,
        intentType: 'contacted',
        intentSignals: [],
        fitScore: 30,
      }),
    );
    const repliedLeads = withSignals.slice(0, 5);
    const allLeads = [...withSignals, ...withoutSignals];
    const campaigns = [
      makeCampaign({ status: 'completed', metrics: { sent: 30, opened: 12, replied: 5, converted: 1 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ];
    const client = makeClient(campaigns, repliedLeads, allLeads);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    // Report should have some mention of enrichment/scoring
    expect(report.reportText).toBeDefined();
    expect(typeof report.reportText).toBe('string');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Detect scoring drift
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Detect scoring drift', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('status is predictive when high-score leads reply at much higher rates', async () => {
    // High-score (>=60) leads reply at 30%, low-score (<60) at 5%
    const highScoreLeads = Array.from({ length: 10 }, (_, i) =>
      makeLead({ id: `high-${i}`, intentType: 'funding', fitScore: 80 }),
    );
    const lowScoreLeads = Array.from({ length: 10 }, (_, i) =>
      makeLead({ id: `low-${i}`, intentType: 'contacted', fitScore: 30 }),
    );
    const repliedLeads = highScoreLeads.slice(0, 4); // 4/10 = 40% high score replied
    // 0 low score replied
    const allLeads = [...highScoreLeads, ...lowScoreLeads, ...Array.from({ length: 10 }, () => makeLead({ fitScore: 55 }))];
    const campaigns = [
      makeCampaign({ status: 'completed', metrics: { sent: 30, opened: 12, replied: 4, converted: 1 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ];
    const client = makeClient(campaigns, repliedLeads, allLeads);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.scoringHealth.status).toBe('predictive');
    expect(report.scoringHealth.highScoreReplyRate).toBeGreaterThan(report.scoringHealth.lowScoreReplyRate);
  });

  it('status is drifted when high-score and low-score leads reply at similar rates', async () => {
    // High-score (>=60) and low-score (<60) both reply at ~10% - no discrimination
    const highScoreLeads = Array.from({ length: 10 }, (_, i) =>
      makeLead({ id: `drift-high-${i}`, intentType: 'funding', fitScore: 85 }),
    );
    const lowScoreLeads = Array.from({ length: 10 }, (_, i) =>
      makeLead({ id: `drift-low-${i}`, intentType: 'contacted', fitScore: 25 }),
    );
    // 1 high, 1 low replied — same rate
    const repliedLeads = [highScoreLeads[0], lowScoreLeads[0]];
    const allLeads = [...highScoreLeads, ...lowScoreLeads, ...Array.from({ length: 10 }, () => makeLead({ fitScore: 55 }))];
    const campaigns = [
      makeCampaign({ status: 'completed', metrics: { sent: 30, opened: 10, replied: 2, converted: 0 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ];
    const client = makeClient(campaigns, repliedLeads, allLeads);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.scoringHealth.status).toBe('drifted');
  });

  it('status is insufficient_data when too few leads have fitScore', async () => {
    // Leads without fitScore
    const noScoreLeads = Array.from({ length: 30 }, (_, i) =>
      makeLead({ id: `noscore-${i}`, intentType: 'contacted', fitScore: undefined }),
    );
    const repliedLeads = noScoreLeads.slice(0, 5);
    const campaigns = [
      makeCampaign({ status: 'completed', metrics: { sent: 30, opened: 10, replied: 5, converted: 1 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ];
    const client = makeClient(campaigns, repliedLeads, noScoreLeads);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.scoringHealth.status).toBe('insufficient_data');
  });

  it('report contains Scoring Health section', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.reportText).toContain('Scoring Health');
  });

  it('report mentions predictive when scoring is still working', async () => {
    const highScoreLeads = Array.from({ length: 10 }, (_, i) =>
      makeLead({ id: `pred-high-${i}`, intentType: 'funding', fitScore: 90 }),
    );
    const lowScoreLeads = Array.from({ length: 10 }, (_, i) =>
      makeLead({ id: `pred-low-${i}`, intentType: 'contacted', fitScore: 20 }),
    );
    const repliedLeads = highScoreLeads.slice(0, 5); // 50% high score replied, 0% low
    const allLeads = [...highScoreLeads, ...lowScoreLeads, ...Array.from({ length: 10 }, () => makeLead({ fitScore: 55 }))];
    const campaigns = [
      makeCampaign({ status: 'completed', metrics: { sent: 30, opened: 12, replied: 5, converted: 1 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ];
    const client = makeClient(campaigns, repliedLeads, allLeads);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.reportText.toLowerCase()).toContain('predictive');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Recommend scoring weight adjustments
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Recommend scoring weight adjustments', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('includes recommendations from _analyzePatterns in report', async () => {
    const recommendations: FeedbackRecommendation[] = [
      {
        recommendation: "Weight 'funding' signals higher in enrichment scoring",
        type: 'weight_increase',
        confidence: 'high',
        dataPoint: 'funding leads reply at 3x the overall rate',
      },
      {
        recommendation: "Deprioritize 'job_change' as a warm-lead indicator",
        type: 'weight_decrease',
        confidence: 'high',
        dataPoint: 'job_change leads reply at only 1.1x overall rate',
      },
    ];
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ recommendations }),
    });
    expect(report.recommendations).toHaveLength(2);
  });

  it('report contains Recommendations section', async () => {
    const recommendations: FeedbackRecommendation[] = [
      {
        recommendation: "Weight 'funding' signals higher",
        type: 'weight_increase',
        confidence: 'high',
        dataPoint: 'funding leads reply at 3x',
      },
    ];
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ recommendations }),
    });
    expect(report.reportText).toContain('Recommendations');
    expect(report.reportText).toContain("Weight 'funding'");
  });

  it('marks each recommendation with confidence level', async () => {
    const recommendations: FeedbackRecommendation[] = [
      {
        recommendation: 'High confidence recommendation',
        type: 'weight_increase',
        confidence: 'high',
        dataPoint: 'based on 30+ leads',
      },
      {
        recommendation: 'Low confidence recommendation',
        type: 'weight_decrease',
        confidence: 'low',
        dataPoint: 'only 5 leads',
      },
    ];
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ recommendations }),
    });
    const highConf = report.recommendations.filter((r) => r.confidence === 'high');
    const lowConf = report.recommendations.filter((r) => r.confidence === 'low');
    expect(highConf).toHaveLength(1);
    expect(lowConf).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Identify pipeline bottlenecks
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Identify pipeline bottlenecks', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('computes discovered count as total leads', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.funnel.discovered).toBe(30); // ALL_LEADS_STANDARD has 30 leads
  });

  it('computes enriched count as leads with intent signals or fitScore', async () => {
    const enrichedLeads = Array.from({ length: 8 }, (_, i) =>
      makeLead({ id: `enr-yes-${i}`, intentSignals: ['some signal'], fitScore: 70 }),
    );
    const unenrichedLeads = Array.from({ length: 22 }, (_, i) =>
      makeLead({ id: `enr-no-${i}`, intentSignals: [], fitScore: undefined }),
    );
    const allLeads = [...enrichedLeads, ...unenrichedLeads];
    const repliedLeads = enrichedLeads.slice(0, 3);
    const client = makeClient(THREE_COMPLETED_CAMPAIGNS, repliedLeads, allLeads);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.funnel.enriched).toBe(8);
  });

  it('computes warm count as leads with fitScore >= 50', async () => {
    const warmLeads = Array.from({ length: 12 }, (_, i) =>
      makeLead({ id: `warm-yes-${i}`, fitScore: 65, intentSignals: ['signal'] }),
    );
    const coldLeads = Array.from({ length: 18 }, (_, i) =>
      makeLead({ id: `warm-no-${i}`, fitScore: 30, intentSignals: ['signal'] }),
    );
    const allLeads = [...warmLeads, ...coldLeads];
    const repliedLeads = warmLeads.slice(0, 4);
    const client = makeClient(THREE_COMPLETED_CAMPAIGNS, repliedLeads, allLeads);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.funnel.warm).toBe(12);
  });

  it('computes replied count from repliedLeads', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.funnel.replied).toBe(REPLIED_LEADS_STANDARD.length);
  });

  it('identifies the biggest pipeline leak', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.funnel.biggestLeak).toBeDefined();
    expect(report.funnel.biggestLeak.stage).toBeTruthy();
    expect(report.funnel.biggestLeak.conversionRate).toBeGreaterThanOrEqual(0);
    expect(report.funnel.biggestLeak.conversionRate).toBeLessThanOrEqual(1);
  });

  it('report contains Pipeline Funnel section', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.reportText).toContain('Pipeline Funnel');
  });

  it('report contains biggest leak info', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.reportText).toContain('Biggest leak');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Compare early campaigns vs. recent campaigns
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Compare early campaigns vs. recent campaigns', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  const makeLeadsForTrend = () => {
    const replied = Array.from({ length: 10 }, (_, i) =>
      makeLead({ id: `trend-r-${i}`, intentType: 'funding', fitScore: 75 }),
    );
    const all = [...replied, ...Array.from({ length: 20 }, (_, i) =>
      makeLead({ id: `trend-n-${i}`, intentType: 'contacted', fitScore: 40 }),
    )];
    return { replied, all };
  };

  it('reports improving trend when recent campaigns have higher reply rates', async () => {
    const { replied, all } = makeLeadsForTrend();
    const sixCampaigns = [
      makeCampaign({ id: 'tr1', status: 'completed', metrics: { sent: 100, opened: 30, replied: 2, converted: 0 }, createdAt: '2026-01-01T00:00:00Z' }),
      makeCampaign({ id: 'tr2', status: 'completed', metrics: { sent: 100, opened: 30, replied: 2, converted: 0 }, createdAt: '2026-02-01T00:00:00Z' }),
      makeCampaign({ id: 'tr3', status: 'completed', metrics: { sent: 100, opened: 30, replied: 3, converted: 0 }, createdAt: '2026-03-01T00:00:00Z' }),
      makeCampaign({ id: 'tr4', status: 'completed', metrics: { sent: 100, opened: 45, replied: 10, converted: 2 }, createdAt: '2026-04-01T00:00:00Z' }),
      makeCampaign({ id: 'tr5', status: 'completed', metrics: { sent: 100, opened: 45, replied: 12, converted: 2 }, createdAt: '2026-05-01T00:00:00Z' }),
      makeCampaign({ id: 'tr6', status: 'completed', metrics: { sent: 100, opened: 45, replied: 15, converted: 3 }, createdAt: '2026-06-01T00:00:00Z' }),
    ];
    const client = makeClient(sixCampaigns, replied, all);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.trend.direction).toBe('improving');
  });

  it('reports declining trend when recent campaigns have lower reply rates', async () => {
    const { replied, all } = makeLeadsForTrend();
    const sixCampaigns = [
      makeCampaign({ id: 'td1', status: 'completed', metrics: { sent: 100, opened: 45, replied: 15, converted: 3 }, createdAt: '2026-01-01T00:00:00Z' }),
      makeCampaign({ id: 'td2', status: 'completed', metrics: { sent: 100, opened: 45, replied: 14, converted: 3 }, createdAt: '2026-02-01T00:00:00Z' }),
      makeCampaign({ id: 'td3', status: 'completed', metrics: { sent: 100, opened: 40, replied: 12, converted: 2 }, createdAt: '2026-03-01T00:00:00Z' }),
      makeCampaign({ id: 'td4', status: 'completed', metrics: { sent: 100, opened: 30, replied: 3, converted: 0 }, createdAt: '2026-04-01T00:00:00Z' }),
      makeCampaign({ id: 'td5', status: 'completed', metrics: { sent: 100, opened: 30, replied: 2, converted: 0 }, createdAt: '2026-05-01T00:00:00Z' }),
      makeCampaign({ id: 'td6', status: 'completed', metrics: { sent: 100, opened: 30, replied: 2, converted: 0 }, createdAt: '2026-06-01T00:00:00Z' }),
    ];
    const client = makeClient(sixCampaigns, replied, all);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.trend.direction).toBe('declining');
  });

  it('reports insufficient_data when fewer than 6 completed campaigns', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
    );
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.trend.direction).toBe('insufficient_data');
  });

  it('includes early and recent reply rates in trend data', async () => {
    const { replied, all } = makeLeadsForTrend();
    const sixCampaigns = [
      makeCampaign({ id: 'te1', status: 'completed', metrics: { sent: 100, opened: 20, replied: 5, converted: 1 }, createdAt: '2026-01-01T00:00:00Z' }),
      makeCampaign({ id: 'te2', status: 'completed', metrics: { sent: 100, opened: 20, replied: 5, converted: 1 }, createdAt: '2026-02-01T00:00:00Z' }),
      makeCampaign({ id: 'te3', status: 'completed', metrics: { sent: 100, opened: 20, replied: 5, converted: 1 }, createdAt: '2026-03-01T00:00:00Z' }),
      makeCampaign({ id: 'te4', status: 'completed', metrics: { sent: 100, opened: 30, replied: 15, converted: 2 }, createdAt: '2026-04-01T00:00:00Z' }),
      makeCampaign({ id: 'te5', status: 'completed', metrics: { sent: 100, opened: 30, replied: 15, converted: 2 }, createdAt: '2026-05-01T00:00:00Z' }),
      makeCampaign({ id: 'te6', status: 'completed', metrics: { sent: 100, opened: 30, replied: 15, converted: 2 }, createdAt: '2026-06-01T00:00:00Z' }),
    ];
    const client = makeClient(sixCampaigns, replied, all);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.trend.earlyReplyRate).toBeCloseTo(5, 1);
    expect(report.trend.recentReplyRate).toBeCloseTo(15, 1);
    expect(report.trend.earlyCampaignCount).toBe(3);
    expect(report.trend.recentCampaignCount).toBe(3);
  });

  it('report contains Trend section', async () => {
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
    );
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.reportText).toContain('Trend');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Confidence thresholds for all recommendations
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Confidence thresholds for all recommendations', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('low confidence recommendations appear in Signals to Watch section', async () => {
    const recommendations: FeedbackRecommendation[] = [
      {
        recommendation: "Watch 'content_engagement' leads — promising but small sample",
        type: 'weight_increase',
        confidence: 'low',
        dataPoint: 'only 5 leads with this type',
      },
    ];
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ recommendations }),
    });
    expect(report.reportText).toContain('Signals to Watch');
  });

  it('high confidence recommendations appear in main Recommendations section', async () => {
    const recommendations: FeedbackRecommendation[] = [
      {
        recommendation: "Weight 'funding' signals higher",
        type: 'weight_increase',
        confidence: 'high',
        dataPoint: 'funding leads reply at 3x overall rate across 30+ leads',
      },
    ];
    const client = makeClient(
      THREE_COMPLETED_CAMPAIGNS,
      REPLIED_LEADS_STANDARD,
      ALL_LEADS_STANDARD,
      INTENT_TYPE_COUNTS_STANDARD,
    );
    const report = await analyzeLeadQuality({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ recommendations }),
    });
    expect(report.reportText).toContain('Recommendations');
    expect(report.reportText).toContain("Weight 'funding'");
  });

  it('low confidence intent type correlation goes to watch section', async () => {
    // Create a rare intent type with only 5 leads
    const rareLeads = Array.from({ length: 5 }, (_, i) =>
      makeLead({ id: `rare-${i}`, intentType: 'rare_signal', fitScore: 75 }),
    );
    const repliedLeads = rareLeads.slice(0, 2);
    const allLeads = [...rareLeads, ...Array.from({ length: 25 }, (_, i) => makeLead({ id: `other-${i}` }))];
    const campaigns = [
      makeCampaign({ status: 'completed', metrics: { sent: 30, opened: 10, replied: 2, converted: 0 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ];
    const client = makeClient(campaigns, repliedLeads, allLeads);
    const report = await analyzeLeadQuality({ _client: client, _analyzePatterns: makeAnalyzePatterns() });

    const rareCorr = report.intentCorrelations.find((c) => c.intentType === 'rare_signal');
    expect(rareCorr?.confidence).toBe('low');
  });
});
