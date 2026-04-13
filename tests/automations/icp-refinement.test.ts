import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  refineIcp,
  type IcpTrait,
  type IcpRefinementSuggestion,
  type ContactSummary,
} from '../../src/automations/icp-refinement.js';
import { AuthError, ConfigError } from '../../src/api/errors.js';
import type { Campaign, Lead, PaginatedLeads } from '../../src/api/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: `camp-${Math.random().toString(36).slice(2)}`,
    name: 'Test Campaign',
    status: 'completed',
    metrics: { sent: 100, opened: 40, replied: 15, converted: 3 },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
    ...overrides,
  };
}

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: `lead-${Math.random().toString(36).slice(2)}`,
    firstName: 'Jane',
    lastName: 'Doe',
    profileUrl: 'https://linkedin.com/in/jane-doe',
    company: 'Acme',
    jobTitle: 'CEO',
    location: 'San Francisco, CA',
    intentType: 'replied',
    ...overrides,
  };
}

function makePaginatedLeads(leads: Lead[]): PaginatedLeads {
  return { leads, total: leads.length, page: 1, pageSize: 100 };
}

type MockClient = {
  getCampaigns: ReturnType<typeof vi.fn>;
  searchLeads: ReturnType<typeof vi.fn>;
};

function makeClient(
  campaigns: Campaign[],
  repliedLeads: Lead[] = [],
  allLeads: Lead[] = [],
): MockClient {
  return {
    getCampaigns: vi.fn().mockResolvedValue(campaigns),
    searchLeads: vi.fn().mockImplementation((filters: { intentType?: string } = {}) => {
      if (filters.intentType === 'replied') {
        return Promise.resolve(makePaginatedLeads(repliedLeads));
      }
      return Promise.resolve(makePaginatedLeads(allLeads));
    }),
  };
}

function makeAnalyzeProfiles(
  result: {
    traits?: IcpTrait[];
    suggestions?: IcpRefinementSuggestion[];
    proposedIcp?: string;
  } = {},
) {
  return vi.fn().mockResolvedValue({
    traits: result.traits ?? [],
    suggestions: result.suggestions ?? [],
    proposedIcp: result.proposedIcp ?? 'Seed-stage fintech founders actively hiring',
  });
}

const CURRENT_ICP = 'Series A SaaS founders in fintech who are actively hiring';

const TWO_COMPLETED_CAMPAIGNS = [
  makeCampaign({
    id: 'c1',
    name: 'Q1 Outreach',
    metrics: { sent: 80, opened: 32, replied: 10, converted: 2 },
  }),
  makeCampaign({
    id: 'c2',
    name: 'Q2 Outreach',
    metrics: { sent: 70, opened: 25, replied: 5, converted: 1 },
  }),
];

const REPLIED_LEADS = Array.from({ length: 15 }, (_, i) =>
  makeLead({ id: `replied-${i}`, intentType: 'replied', jobTitle: 'Founder', company: `Company${i}` }),
);

const ALL_LEADS = [
  ...REPLIED_LEADS,
  ...Array.from({ length: 85 }, (_, i) =>
    makeLead({ id: `noreply-${i}`, intentType: 'contacted', jobTitle: 'VP Engineering', company: `BigCo${i}` }),
  ),
];

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Reject run when ICP description is missing
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Reject run when ICP description is missing', () => {
  beforeEach(() => {
    delete process.env.ICP_DESCRIPTION;
  });

  it('throws ConfigError with correct message', async () => {
    await expect(refineIcp()).rejects.toThrow(ConfigError);
  });

  it('throws error mentioning ICP_DESCRIPTION and .env.local', async () => {
    await expect(refineIcp()).rejects.toThrow('ICP_DESCRIPTION');
  });

  it('throws error mentioning .env.local', async () => {
    await expect(refineIcp()).rejects.toThrow('.env.local');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle API authentication failure
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle API authentication failure', () => {
  it('throws AuthError and does not output a partial report', async () => {
    const client: MockClient = {
      getCampaigns: vi.fn().mockRejectedValue(new AuthError()),
      searchLeads: vi.fn(),
    };
    await expect(
      refineIcp({
        icpDescription: CURRENT_ICP,
        _client: client,
        _analyzeProfiles: makeAnalyzeProfiles(),
      }),
    ).rejects.toThrow(AuthError);
    expect(client.searchLeads).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Reject run when insufficient campaign data
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Reject run when insufficient campaign data', () => {
  it('returns empty suggestions with insufficient completed campaigns', async () => {
    const client = makeClient([
      makeCampaign({ id: 'c1', status: 'completed', metrics: { sent: 50, opened: 20, replied: 5, converted: 1 } }),
    ]);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles(),
      minCampaigns: 2,
    });
    expect(report.suggestions).toHaveLength(0);
  });

  it('report mentions minimum campaign threshold', async () => {
    const client = makeClient([
      makeCampaign({ id: 'c1', status: 'completed', metrics: { sent: 50, opened: 20, replied: 5, converted: 1 } }),
    ]);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles(),
      minCampaigns: 2,
    });
    expect(report.reportText).toContain('2');
    expect(report.reportText).toContain('1');
  });

  it('does not call analyzeProfiles when insufficient data', async () => {
    const client = makeClient([
      makeCampaign({ id: 'c1', status: 'completed', metrics: { sent: 50, opened: 20, replied: 5, converted: 1 } }),
    ]);
    const analyze = makeAnalyzeProfiles();
    await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: analyze,
      minCampaigns: 2,
    });
    expect(analyze).not.toHaveBeenCalled();
  });

  it('proposedIcp is null when insufficient data', async () => {
    const client = makeClient([makeCampaign({ status: 'completed', metrics: { sent: 50, opened: 20, replied: 5, converted: 1 } })]);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles(),
      minCampaigns: 2,
    });
    expect(report.proposedIcp).toBeNull();
  });

  it('ignores non-completed campaigns for threshold', async () => {
    const campaigns = [
      makeCampaign({ status: 'active', metrics: { sent: 50, opened: 20, replied: 5, converted: 1 } }),
      makeCampaign({ status: 'completed', metrics: { sent: 50, opened: 20, replied: 5, converted: 1 } }),
    ];
    const analyze = makeAnalyzeProfiles();
    const client = makeClient(campaigns);
    await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: analyze,
      minCampaigns: 2,
    });
    expect(analyze).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle zero replies across all campaigns
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle zero replies across all campaigns', () => {
  const zeroReplyCampaigns = [
    makeCampaign({ id: 'c1', status: 'completed', metrics: { sent: 50, opened: 10, replied: 0, converted: 0 } }),
    makeCampaign({ id: 'c2', status: 'completed', metrics: { sent: 60, opened: 15, replied: 0, converted: 0 } }),
    makeCampaign({ id: 'c3', status: 'completed', metrics: { sent: 70, opened: 20, replied: 0, converted: 0 } }),
  ];

  it('returns report with suggestions: []', async () => {
    const client = makeClient(zeroReplyCampaigns);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles(),
    });
    expect(report.suggestions).toHaveLength(0);
  });

  it('report mentions campaign count', async () => {
    const client = makeClient(zeroReplyCampaigns);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles(),
    });
    expect(report.reportText).toContain('3');
  });

  it('report suggests improving messages', async () => {
    const client = makeClient(zeroReplyCampaigns);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles(),
    });
    expect(report.reportText).toContain('messages');
  });

  it('does not call analyzeProfiles when zero replies', async () => {
    const client = makeClient(zeroReplyCampaigns);
    const analyze = makeAnalyzeProfiles();
    await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: analyze,
    });
    expect(analyze).not.toHaveBeenCalled();
  });

  it('proposedIcp is null when zero replies', async () => {
    const client = makeClient(zeroReplyCampaigns);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles(),
    });
    expect(report.proposedIcp).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate ICP refinement suggestions from campaign results
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate ICP refinement suggestions from campaign results', () => {
  it('fetches all campaigns via getCampaigns', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles(),
    });
    expect(client.getCampaigns).toHaveBeenCalledTimes(1);
  });

  it('fetches replied leads from searchLeads with intentType replied', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles(),
    });
    expect(client.searchLeads).toHaveBeenCalledWith(expect.objectContaining({ intentType: 'replied' }));
  });

  it('fetches non-replied leads', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles(),
    });
    // Called at least twice: once for replied, once for all
    expect(client.searchLeads).toHaveBeenCalledTimes(2);
  });

  it('calls analyzeProfiles with current ICP and lead segments', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const analyze = makeAnalyzeProfiles();
    await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: analyze,
    });
    expect(analyze).toHaveBeenCalledWith(
      CURRENT_ICP,
      expect.any(Array),
      expect.any(Array),
    );
  });

  it('report contains current ICP', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles(),
    });
    expect(report.reportText).toContain(CURRENT_ICP);
    expect(report.currentIcp).toBe(CURRENT_ICP);
  });

  it('report contains campaign count and overall stats', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles(),
    });
    expect(report.campaignCount).toBe(2);
    expect(report.totalSent).toBe(150); // 80 + 70
    expect(report.totalReplied).toBe(15); // 10 + 5
  });

  it('computes overall reply rate correctly', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles(),
    });
    // 15/150 * 100 = 10%
    expect(report.overallReplyRate).toBeCloseTo(10, 1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Identify winning lead profile patterns
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Identify winning lead profile patterns', () => {
  const workingTraits: IcpTrait[] = [
    { trait: 'Founder / CEO title', replyRate: 22, sampleSize: 50, replied: 11, category: 'working', confidence: 'high' },
    { trait: 'Fintech vertical', replyRate: 18, sampleSize: 40, replied: 7, category: 'working', confidence: 'high' },
    { trait: 'Seed-stage company', replyRate: 22, sampleSize: 30, replied: 7, category: 'working', confidence: 'high' },
  ];

  it('returns working traits from analysis', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({ traits: workingTraits }),
    });
    expect(report.traits.working).toHaveLength(3);
    expect(report.traits.working[0].trait).toBe('Founder / CEO title');
  });

  it('report includes What\'s Working section with working traits', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({ traits: workingTraits }),
    });
    expect(report.reportText).toContain("What's Working");
    expect(report.reportText).toContain('Founder / CEO title');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Compare replied vs. non-replied lead profiles
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Compare replied vs. non-replied lead profiles', () => {
  const mixedTraits: IcpTrait[] = [
    { trait: 'Fintech vertical', replyRate: 18, sampleSize: 40, replied: 7, category: 'working', confidence: 'high' },
    { trait: 'VP Engineering title', replyRate: 1, sampleSize: 50, replied: 1, category: 'not_working', confidence: 'high' },
    { trait: 'Enterprise (500+ employees)', replyRate: 1, sampleSize: 80, replied: 1, category: 'not_working', confidence: 'high' },
  ];

  it('separates traits into working and not_working categories', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({ traits: mixedTraits }),
    });
    expect(report.traits.working).toHaveLength(1);
    expect(report.traits.notWorking).toHaveLength(2);
  });

  it('report includes What\'s Not Working section', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({ traits: mixedTraits }),
    });
    expect(report.reportText).toContain("What's Not Working");
    expect(report.reportText).toContain('VP Engineering title');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Suggest specific ICP description changes
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Suggest specific ICP description changes', () => {
  const suggestions: IcpRefinementSuggestion[] = [
    {
      type: 'remove',
      trait: 'Series A founders',
      reason: 'Seed-stage founders reply at 22% vs. 7% for Series A',
      confidence: 'high',
    },
    {
      type: 'add',
      trait: 'Seed-stage founders',
      reason: '22% reply rate (3x higher than Series A)',
      confidence: 'high',
    },
  ];
  const proposedIcp = 'Seed-stage SaaS founders in fintech who are actively hiring';

  it('returns suggestions from analysis', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({ suggestions, proposedIcp }),
    });
    expect(report.suggestions).toHaveLength(2);
  });

  it('returns proposed ICP', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({ suggestions, proposedIcp }),
    });
    expect(report.proposedIcp).toBe(proposedIcp);
  });

  it('report includes current and proposed ICP in Suggested ICP Update section', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({ suggestions, proposedIcp }),
    });
    expect(report.reportText).toContain('Suggested ICP Update');
    expect(report.reportText).toContain(CURRENT_ICP);
    expect(report.reportText).toContain(proposedIcp);
  });

  it('report includes data-backed reason for each suggestion', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({ suggestions, proposedIcp }),
    });
    expect(report.reportText).toContain('Seed-stage founders reply at 22%');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Founder approves ICP refinement (approval gate is manual)
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Founder approves ICP refinement', () => {
  it('report tells founder to update ICP_DESCRIPTION in .env.local', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({
        suggestions: [{ type: 'add', trait: 'Seed-stage', reason: 'Higher reply rate', confidence: 'high' }],
        proposedIcp: 'Seed-stage fintech founders',
      }),
    });
    expect(report.reportText).toContain('ICP_DESCRIPTION');
    expect(report.reportText).toContain('.env.local');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Identify ICP traits that predict non-response
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Identify ICP traits that predict non-response', () => {
  const notWorkingTraits: IcpTrait[] = [
    { trait: 'VP of Engineering title', replyRate: 0, sampleSize: 20, replied: 0, category: 'not_working', confidence: 'high' },
    { trait: '500+ employee companies', replyRate: 1, sampleSize: 80, replied: 1, category: 'not_working', confidence: 'high' },
  ];

  it('report includes signals to deprioritize section', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({ traits: notWorkingTraits }),
    });
    expect(report.reportText).toContain("What's Not Working");
  });

  it('lists traits correlating with low reply rates', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({ traits: notWorkingTraits }),
    });
    expect(report.traits.notWorking).toHaveLength(2);
    expect(report.reportText).toContain('VP of Engineering title');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Preserve what's already working in the ICP
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Preserve what\'s already working in the ICP', () => {
  const mixedTraits: IcpTrait[] = [
    { trait: 'Fintech vertical', replyRate: 18, sampleSize: 50, replied: 9, category: 'working', confidence: 'high' },
    { trait: 'Actively hiring signal', replyRate: 10, sampleSize: 30, replied: 3, category: 'inconclusive', confidence: 'high' },
  ];

  it('affirms working traits in the report', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({ traits: mixedTraits }),
    });
    expect(report.traits.working[0].trait).toBe('Fintech vertical');
    expect(report.reportText).toContain("What's Working");
    expect(report.reportText).toContain('Fintech vertical');
  });

  it('flags inconclusive traits separately', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({ traits: mixedTraits }),
    });
    expect(report.traits.inconclusive).toHaveLength(1);
    expect(report.reportText).toContain('Inconclusive');
    expect(report.reportText).toContain('Actively hiring signal');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Confidence threshold for suggestions
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Confidence threshold for suggestions', () => {
  const smallSampleTrait: IcpTrait = {
    trait: 'AI/ML vertical',
    replyRate: 25,
    sampleSize: 4,
    replied: 1,
    category: 'working',
    confidence: 'high', // will be overridden to 'low' due to small sample
  };

  it('overrides confidence to low for small sample size traits', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({ traits: [smallSampleTrait] }),
    });
    // Any trait with sampleSize < 10 should be low confidence
    const allTraits = [
      ...report.traits.working,
      ...report.traits.notWorking,
      ...report.traits.inconclusive,
      ...report.traits.watch,
    ];
    const aiMlTrait = allTraits.find((t) => t.trait === 'AI/ML vertical');
    expect(aiMlTrait?.confidence).toBe('low');
  });

  it('moves small-sample working traits to watch category', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({ traits: [smallSampleTrait] }),
    });
    // With sampleSize 4, this should move to 'watch'
    expect(report.traits.watch.some((t) => t.trait === 'AI/ML vertical')).toBe(true);
    expect(report.traits.working.some((t) => t.trait === 'AI/ML vertical')).toBe(false);
  });

  it('report includes Signals to Watch section for low confidence traits', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({ traits: [smallSampleTrait] }),
    });
    expect(report.reportText).toContain('Signals to Watch');
    expect(report.reportText).toContain('AI/ML vertical');
  });

  it('low confidence suggestions are not included as primary recommendations', async () => {
    const lowConfSuggestion: IcpRefinementSuggestion = {
      type: 'add',
      trait: 'AI/ML vertical',
      reason: 'Promising but only 4 leads contacted',
      confidence: 'low',
    };
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({
        suggestions: [lowConfSuggestion],
        traits: [smallSampleTrait],
      }),
    });
    // proposedIcp should be null when only low-confidence suggestions exist
    expect(report.proposedIcp).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Report output format
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Report output format', () => {
  it('report starts with ICP Refinement Report header', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles(),
    });
    expect(report.reportText).toContain('ICP Refinement Report');
  });

  it('report contains overall stats line', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles(),
    });
    expect(report.reportText).toContain('2 campaigns');
    expect(report.reportText).toContain('15');
    expect(report.reportText).toContain('150');
  });

  it('modify suggestion includes arrow notation in report', async () => {
    const modifySuggestion: IcpRefinementSuggestion = {
      type: 'modify',
      trait: 'Series A founders',
      newTrait: 'Seed-stage founders',
      reason: 'Seed-stage reply at 3x rate',
      confidence: 'high',
    };
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await refineIcp({
      icpDescription: CURRENT_ICP,
      _client: client,
      _analyzeProfiles: makeAnalyzeProfiles({
        suggestions: [modifySuggestion],
        proposedIcp: 'Seed-stage SaaS founders in fintech',
      }),
    });
    expect(report.reportText).toContain('→');
    expect(report.reportText).toContain('Seed-stage founders');
  });
});
