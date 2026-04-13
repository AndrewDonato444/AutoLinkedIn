import { describe, it, expect, vi } from 'vitest';
import {
  optimizeMessageStyle,
  type HookStyleAnalysis,
  type LengthBucket,
  type SignalEffectiveness,
  type PhraseAnalysis,
  type StyleRecommendation,
} from '../../src/automations/message-style-optimization.js';
import { AuthError } from '../../src/api/errors.js';
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
    personalizedMessages: ['Hey, saw you just hired 3 engineers — great signal of growth!'],
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
      if (filters?.intentType === 'replied') {
        return Promise.resolve(makePaginatedLeads(repliedLeads));
      }
      return Promise.resolve(makePaginatedLeads(allLeads));
    }),
  };
}

function makeAnalyzePatterns(
  result: Partial<{
    hookStyles: HookStyleAnalysis[];
    lengthBuckets: LengthBucket[];
    avgLengthReplied: number;
    avgLengthNoReply: number;
    signalEffectiveness: SignalEffectiveness[];
    phrasesToAvoid: PhraseAnalysis[];
    patternsToWatch: (HookStyleAnalysis | SignalEffectiveness)[];
    recommendations: StyleRecommendation[];
  }> = {},
) {
  return vi.fn().mockResolvedValue({
    hookStyles: result.hookStyles ?? [],
    lengthBuckets: result.lengthBuckets ?? [],
    avgLengthReplied: result.avgLengthReplied ?? 180,
    avgLengthNoReply: result.avgLengthNoReply ?? 250,
    signalEffectiveness: result.signalEffectiveness ?? [],
    phrasesToAvoid: result.phrasesToAvoid ?? [],
    patternsToWatch: result.patternsToWatch ?? [],
    recommendations: result.recommendations ?? [],
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Fixture data
// ──────────────────────────────────────────────────────────────────────────────

const TWO_COMPLETED_CAMPAIGNS = [
  makeCampaign({ id: 'c1', name: 'Q1 Outreach', metrics: { sent: 80, opened: 32, replied: 10, converted: 2 } }),
  makeCampaign({ id: 'c2', name: 'Q2 Outreach', metrics: { sent: 70, opened: 25, replied: 5, converted: 1 } }),
];

const REPLIED_LEADS = Array.from({ length: 15 }, (_, i) =>
  makeLead({
    id: `replied-${i}`,
    intentType: 'replied',
    personalizedMessages: [`Quick question — are you still hiring engineers? Saw ${i + 1} new posts.`],
  }),
);

const NON_REPLIED_LEADS = Array.from({ length: 85 }, (_, i) =>
  makeLead({
    id: `noreply-${i}`,
    intentType: 'contacted',
    personalizedMessages: [`I'd love to connect and explore synergies with your team.`],
  }),
);

const ALL_LEADS = [...REPLIED_LEADS, ...NON_REPLIED_LEADS];

const HOOK_STYLES: HookStyleAnalysis[] = [
  { style: 'question', count: 40, replied: 16, replyRate: 40, confidence: 'high' },
  { style: 'compliment', count: 30, replied: 6, replyRate: 20, confidence: 'high' },
  { style: 'direct_ask', count: 20, replied: 4, replyRate: 20, confidence: 'high' },
  { style: 'mutual_connection', count: 10, replied: 1, replyRate: 10, confidence: 'high' },
];

const LENGTH_BUCKETS: LengthBucket[] = [
  { range: 'under_150', label: 'Under 150 chars', count: 30, replied: 12, replyRate: 40 },
  { range: '150_250', label: '150-250 chars', count: 50, replied: 10, replyRate: 20 },
  { range: '250_plus', label: '250+ chars', count: 20, replied: 3, replyRate: 15 },
];

const SIGNAL_EFFECTIVENESS: SignalEffectiveness[] = [
  { signalType: 'hiring', count: 40, replied: 16, replyRate: 40, impact: 'drives_replies', confidence: 'high' },
  { signalType: 'fundraising', count: 20, replied: 4, replyRate: 20, impact: 'drives_replies', confidence: 'high' },
  { signalType: 'product_launch', count: 35, replied: 5, replyRate: 14, impact: 'no_impact', confidence: 'high' },
];

const PHRASES_TO_AVOID: PhraseAnalysis[] = [
  { phrase: "I'd love to connect", count: 30, replied: 2, replyRate: 6.7 },
  { phrase: 'reaching out because', count: 20, replied: 1, replyRate: 5 },
];

const RECOMMENDATIONS: StyleRecommendation[] = [
  {
    type: 'hook_style',
    recommendation: 'Use question openers',
    data: 'Question openers get 40% reply rate vs 20% for compliments',
    confidence: 'high',
    envVar: undefined,
    suggestedValue: undefined,
  },
  {
    type: 'message_length',
    recommendation: 'Keep messages under 150 chars',
    data: 'Under 150 chars: 40% reply rate vs 15% for 250+ chars',
    confidence: 'high',
    envVar: 'MESSAGE_MAX_LENGTH',
    suggestedValue: '150',
  },
  {
    type: 'tone',
    recommendation: 'Switch MESSAGE_TONE to casual',
    data: 'Casual messages reply at 35% vs 18% for professional',
    confidence: 'high',
    envVar: 'MESSAGE_TONE',
    suggestedValue: 'casual',
  },
];

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
      optimizeMessageStyle({ _client: client, _analyzePatterns: makeAnalyzePatterns() }),
    ).rejects.toThrow(AuthError);
    expect(client.searchLeads).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Reject run when insufficient campaign data
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Reject run when insufficient campaign data', () => {
  it('returns empty report when fewer than minCampaigns completed campaigns', async () => {
    const client = makeClient(
      [makeCampaign({ id: 'c1', status: 'completed', metrics: { sent: 50, opened: 20, replied: 5, converted: 1 } })],
      REPLIED_LEADS,
      ALL_LEADS,
    );
    const report = await optimizeMessageStyle({
      minCampaigns: 2,
      _client: client,
      _analyzePatterns: makeAnalyzePatterns(),
    });
    expect(report.recommendations).toHaveLength(0);
  });

  it('report text mentions minimum threshold and current count', async () => {
    const client = makeClient(
      [makeCampaign({ id: 'c1', status: 'completed', metrics: { sent: 50, opened: 20, replied: 5, converted: 1 } })],
    );
    const report = await optimizeMessageStyle({
      minCampaigns: 2,
      _client: client,
      _analyzePatterns: makeAnalyzePatterns(),
    });
    expect(report.reportText).toContain('2');
    expect(report.reportText).toContain('1');
  });

  it('does not call analyzePatterns when insufficient campaigns', async () => {
    const client = makeClient(
      [makeCampaign({ status: 'completed' })],
    );
    const analyze = makeAnalyzePatterns();
    await optimizeMessageStyle({ minCampaigns: 2, _client: client, _analyzePatterns: analyze });
    expect(analyze).not.toHaveBeenCalled();
  });

  it('ignores non-completed campaigns for threshold', async () => {
    const client = makeClient([
      makeCampaign({ status: 'active' }),
      makeCampaign({ status: 'completed', metrics: { sent: 50, opened: 20, replied: 5, converted: 1 } }),
    ]);
    const analyze = makeAnalyzePatterns();
    await optimizeMessageStyle({ minCampaigns: 2, _client: client, _analyzePatterns: analyze });
    expect(analyze).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Reject run when insufficient messaged leads
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Reject run when insufficient messaged leads', () => {
  it('returns empty report when fewer than minMessages leads with personalizedMessages', async () => {
    // Only 5 leads with personalizedMessages
    const fewLeads = Array.from({ length: 5 }, (_, i) =>
      makeLead({ id: `l-${i}`, personalizedMessages: ['test message'] }),
    );
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, fewLeads, fewLeads);
    const report = await optimizeMessageStyle({
      minMessages: 10,
      _client: client,
      _analyzePatterns: makeAnalyzePatterns(),
    });
    expect(report.recommendations).toHaveLength(0);
  });

  it('report text mentions minimum threshold and current count', async () => {
    const fewLeads = Array.from({ length: 5 }, (_, i) =>
      makeLead({ id: `l-${i}`, personalizedMessages: ['test message'] }),
    );
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, fewLeads, fewLeads);
    const report = await optimizeMessageStyle({
      minMessages: 10,
      _client: client,
      _analyzePatterns: makeAnalyzePatterns(),
    });
    expect(report.reportText).toContain('10');
    expect(report.reportText).toContain('5');
  });

  it('does not call analyzePatterns when insufficient leads', async () => {
    const fewLeads = Array.from({ length: 5 }, (_, i) =>
      makeLead({ id: `l-${i}`, personalizedMessages: ['msg'] }),
    );
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, fewLeads, fewLeads);
    const analyze = makeAnalyzePatterns();
    await optimizeMessageStyle({ minMessages: 10, _client: client, _analyzePatterns: analyze });
    expect(analyze).not.toHaveBeenCalled();
  });

  it('only counts leads that have personalizedMessages', async () => {
    // Mix of leads: some with messages, some without
    const leadsNoMessages = Array.from({ length: 8 }, (_, i) =>
      makeLead({ id: `nm-${i}`, personalizedMessages: undefined }),
    );
    const leadsWithMessages = Array.from({ length: 4 }, (_, i) =>
      makeLead({ id: `wm-${i}`, personalizedMessages: ['a message'] }),
    );
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, leadsWithMessages, [...leadsNoMessages, ...leadsWithMessages]);
    const report = await optimizeMessageStyle({
      minMessages: 10,
      _client: client,
      _analyzePatterns: makeAnalyzePatterns(),
    });
    // Only 4 with messages — below threshold of 10
    expect(report.recommendations).toHaveLength(0);
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

  it('returns report with recommendations: []', async () => {
    const client = makeClient(zeroReplyCampaigns, [], ALL_LEADS);
    const report = await optimizeMessageStyle({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.recommendations).toHaveLength(0);
  });

  it('report mentions ICP refinement and not optimizing what has not been validated', async () => {
    const client = makeClient(zeroReplyCampaigns, [], ALL_LEADS);
    const report = await optimizeMessageStyle({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.reportText).toContain("No replies yet");
  });

  it('does not call analyzePatterns when zero replies', async () => {
    const client = makeClient(zeroReplyCampaigns, [], ALL_LEADS);
    const analyze = makeAnalyzePatterns();
    await optimizeMessageStyle({ _client: client, _analyzePatterns: analyze });
    expect(analyze).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate message style analysis from campaign results
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate message style analysis from campaign results', () => {
  it('fetches all campaigns via getCampaigns', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    await optimizeMessageStyle({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(client.getCampaigns).toHaveBeenCalledTimes(1);
  });

  it('fetches replied leads with intentType replied', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    await optimizeMessageStyle({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(client.searchLeads).toHaveBeenCalledWith(
      expect.objectContaining({ intentType: 'replied' }),
    );
  });

  it('fetches all messaged leads (no intentType filter)', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    await optimizeMessageStyle({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(client.searchLeads).toHaveBeenCalledTimes(2);
  });

  it('calls analyzePatterns with replied and non-replied messages', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const analyze = makeAnalyzePatterns();
    await optimizeMessageStyle({ _client: client, _analyzePatterns: analyze });
    expect(analyze).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ message: expect.any(String) })]),
      expect.arrayContaining([expect.objectContaining({ message: expect.any(String) })]),
      expect.any(String),
    );
  });

  it('computes correct campaign count and totals', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.campaignCount).toBe(2);
    expect(report.totalMessaged).toBeGreaterThan(0);
    expect(report.totalReplied).toBeGreaterThan(0);
  });

  it('computes correct overall reply rate', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    // 15 replied / 100 messaged = 15%
    expect(report.overallReplyRate).toBeCloseTo(15, 0);
  });

  it('report starts with Message Style Optimization Report header', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({ _client: client, _analyzePatterns: makeAnalyzePatterns() });
    expect(report.reportText).toContain('Message Style Optimization Report');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Identify winning hook styles
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Identify winning hook styles', () => {
  it('returns hookStyles from analysis', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ hookStyles: HOOK_STYLES }),
    });
    expect(report.hookStyles).toHaveLength(4);
    expect(report.hookStyles[0].style).toBe('question');
  });

  it('report includes Hook Style Analysis section', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ hookStyles: HOOK_STYLES }),
    });
    expect(report.reportText).toContain('Hook Style Analysis');
  });

  it('report shows best and worst hook style', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ hookStyles: HOOK_STYLES }),
    });
    expect(report.reportText).toContain('question');
    expect(report.reportText).toContain('Best');
    expect(report.reportText).toContain('Worst');
  });

  it('report shows reply rates for each hook style', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ hookStyles: HOOK_STYLES }),
    });
    expect(report.reportText).toContain('40%');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Analyze optimal message length
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Analyze optimal message length', () => {
  it('returns lengthBuckets from analysis', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ lengthBuckets: LENGTH_BUCKETS, avgLengthReplied: 120, avgLengthNoReply: 280 }),
    });
    expect(report.lengthBuckets).toHaveLength(3);
  });

  it('report includes Message Length Analysis section', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ lengthBuckets: LENGTH_BUCKETS }),
    });
    expect(report.reportText).toContain('Message Length Analysis');
  });

  it('report shows avg length for replied and non-replied', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ avgLengthReplied: 120, avgLengthNoReply: 280 }),
    });
    expect(report.avgLengthReplied).toBe(120);
    expect(report.avgLengthNoReply).toBe(280);
    expect(report.reportText).toContain('120');
    expect(report.reportText).toContain('280');
  });

  it('report shows optimal length range', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ lengthBuckets: LENGTH_BUCKETS }),
    });
    expect(report.reportText).toContain('Optimal range');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Identify which personalization elements drive replies
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Identify which personalization elements drive replies', () => {
  it('returns signalEffectiveness from analysis', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ signalEffectiveness: SIGNAL_EFFECTIVENESS }),
    });
    expect(report.signalEffectiveness).toHaveLength(3);
  });

  it('report includes Signal Effectiveness section', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ signalEffectiveness: SIGNAL_EFFECTIVENESS }),
    });
    expect(report.reportText).toContain('Signal Effectiveness');
  });

  it('report shows signals that drive replies vs no impact', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ signalEffectiveness: SIGNAL_EFFECTIVENESS }),
    });
    expect(report.reportText).toContain('hiring');
    expect(report.reportText).toContain('product_launch');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Detect template-sounding messages that underperform
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Detect template-sounding messages that underperform', () => {
  it('returns phrasesToAvoid from analysis', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ phrasesToAvoid: PHRASES_TO_AVOID }),
    });
    expect(report.phrasesToAvoid).toHaveLength(2);
  });

  it('report includes Phrases to Avoid section', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ phrasesToAvoid: PHRASES_TO_AVOID }),
    });
    expect(report.reportText).toContain('Phrases to Avoid');
  });

  it('report includes the weak phrases with reply rates', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ phrasesToAvoid: PHRASES_TO_AVOID }),
    });
    expect(report.reportText).toContain("I'd love to connect");
    expect(report.reportText).toContain('reaching out because');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Confidence threshold for recommendations
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Confidence threshold for recommendations', () => {
  const lowConfidenceHook: HookStyleAnalysis = {
    style: 'direct_ask',
    count: 3,
    replied: 1,
    replyRate: 33,
    confidence: 'low',
  };

  it('low confidence hooks go into patternsToWatch', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({
        hookStyles: [lowConfidenceHook],
        patternsToWatch: [lowConfidenceHook],
      }),
    });
    expect(report.patternsToWatch.length).toBeGreaterThan(0);
  });

  it('report includes Patterns to Watch section for low confidence findings', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({
        patternsToWatch: [lowConfidenceHook],
      }),
    });
    expect(report.reportText).toContain('Patterns to Watch');
    expect(report.reportText).toContain('low confidence');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate updated message generation guidance
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate updated message generation guidance', () => {
  it('returns recommendations from analysis', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ recommendations: RECOMMENDATIONS }),
    });
    expect(report.recommendations).toHaveLength(3);
  });

  it('report includes Recommendations section', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ recommendations: RECOMMENDATIONS }),
    });
    expect(report.reportText).toContain('Recommendations');
  });

  it('each recommendation is numbered in the report', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ recommendations: RECOMMENDATIONS }),
    });
    expect(report.reportText).toContain('1.');
    expect(report.reportText).toContain('2.');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Compare current tone setting against what actually works
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Compare current tone setting against what actually works', () => {
  const toneRec: StyleRecommendation = {
    type: 'tone',
    recommendation: "Switch MESSAGE_TONE to 'casual'",
    data: "Casual messages reply at 35% vs 18% for 'professional'",
    confidence: 'high',
    envVar: 'MESSAGE_TONE',
    suggestedValue: 'casual',
  };

  it('passes current tone to analyzePatterns', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const analyze = makeAnalyzePatterns();
    await optimizeMessageStyle({ currentTone: 'professional', _client: client, _analyzePatterns: analyze });
    expect(analyze).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      'professional',
    );
  });

  it('includes tone recommendation in report when suggested', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      currentTone: 'professional',
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ recommendations: [toneRec] }),
    });
    expect(report.reportText).toContain('MESSAGE_TONE');
    expect(report.reportText).toContain('casual');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Output summary with actionable next steps
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Output summary with actionable next steps', () => {
  it('report includes Next Steps section', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ recommendations: RECOMMENDATIONS }),
    });
    expect(report.reportText).toContain('Next Steps');
  });

  it('report reminds founder to run message generation with forceRegenerate', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ recommendations: RECOMMENDATIONS }),
    });
    expect(report.reportText).toContain('forceRegenerate');
  });

  it('report lists env vars to update when recommendations include them', async () => {
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ recommendations: RECOMMENDATIONS }),
    });
    expect(report.reportText).toContain('MESSAGE_MAX_LENGTH');
    expect(report.reportText).toContain('MESSAGE_TONE');
  });

  it('next steps are present even when recommendations have no env var', async () => {
    const hookOnlyRec: StyleRecommendation = {
      type: 'hook_style',
      recommendation: 'Use question openers',
      data: '40% reply rate',
      confidence: 'high',
    };
    const client = makeClient(TWO_COMPLETED_CAMPAIGNS, REPLIED_LEADS, ALL_LEADS);
    const report = await optimizeMessageStyle({
      _client: client,
      _analyzePatterns: makeAnalyzePatterns({ recommendations: [hookOnlyRec] }),
    });
    expect(report.reportText).toContain('Next Steps');
    expect(report.reportText).toContain('forceRegenerate');
  });
});
