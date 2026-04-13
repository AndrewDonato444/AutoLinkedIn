import { describe, it, expect, vi } from 'vitest';
import { analyzeCampaignPerformance } from '../../src/automations/campaign-performance-analytics.js';
import { AuthError } from '../../src/api/errors.js';
import type { Campaign } from '../../src/api/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'camp-1',
    name: 'Test Campaign',
    status: 'active',
    metrics: { sent: 100, opened: 40, replied: 20, converted: 5 },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

type MockClient = {
  getCampaigns: ReturnType<typeof vi.fn>;
};

function makeMockClient(campaigns: Campaign[]): MockClient {
  return {
    getCampaigns: vi.fn().mockResolvedValue(campaigns),
  };
}

function makeMockClientThrowing(error: Error): MockClient {
  return {
    getCampaigns: vi.fn().mockRejectedValue(error),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate performance report for all campaigns
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate performance report for all campaigns', () => {
  it('fetches all campaigns via getCampaigns', async () => {
    const client = makeMockClient([makeCampaign()]);
    await analyzeCampaignPerformance({ _client: client });
    expect(client.getCampaigns).toHaveBeenCalledTimes(1);
  });

  it('computes reply rate as replied/sent*100', async () => {
    const campaign = makeCampaign({ metrics: { sent: 100, opened: 40, replied: 20, converted: 5 } });
    const client = makeMockClient([campaign]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.campaigns[0].replyRate).toBe(20);
  });

  it('computes open rate as opened/sent*100', async () => {
    const campaign = makeCampaign({ metrics: { sent: 100, opened: 40, replied: 20, converted: 5 } });
    const client = makeMockClient([campaign]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.campaigns[0].openRate).toBe(40);
  });

  it('computes conversion rate as converted/sent*100', async () => {
    const campaign = makeCampaign({ metrics: { sent: 100, opened: 40, replied: 20, converted: 5 } });
    const client = makeMockClient([campaign]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.campaigns[0].conversionRate).toBe(5);
  });

  it('ranks campaigns by reply rate highest first', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', name: 'Low', metrics: { sent: 100, opened: 10, replied: 5, converted: 1 } }),
      makeCampaign({ id: 'c2', name: 'High', metrics: { sent: 100, opened: 50, replied: 40, converted: 10 } }),
      makeCampaign({ id: 'c3', name: 'Mid', metrics: { sent: 100, opened: 30, replied: 20, converted: 3 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.campaigns[0].name).toBe('High');
    expect(report.campaigns[1].name).toBe('Mid');
    expect(report.campaigns[2].name).toBe('Low');
  });

  it('outputs a reportText string', async () => {
    const client = makeMockClient([makeCampaign()]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(typeof report.reportText).toBe('string');
    expect(report.reportText.length).toBeGreaterThan(0);
  });

  it('reportText contains campaign performance report header', async () => {
    const client = makeMockClient([makeCampaign()]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.reportText).toContain('Campaign Performance Report');
  });

  it('computes overall averages across campaigns with sends', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', metrics: { sent: 100, opened: 40, replied: 20, converted: 5 } }),
      makeCampaign({ id: 'c2', metrics: { sent: 200, opened: 60, replied: 40, converted: 10 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    // avg reply rate: (20 + 20) / 2 = 20
    expect(report.overallAverages.replyRate).toBe(20);
    // total sent: 300
    expect(report.overallAverages.totalSent).toBe(300);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Compare active vs. completed campaigns
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Compare active vs. completed campaigns', () => {
  it('groups campaigns by status', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', status: 'active' }),
      makeCampaign({ id: 'c2', status: 'completed' }),
      makeCampaign({ id: 'c3', status: 'paused' }),
      makeCampaign({ id: 'c4', status: 'draft', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.byStatus['active']).toHaveLength(1);
    expect(report.byStatus['completed']).toHaveLength(1);
    expect(report.byStatus['paused']).toHaveLength(1);
    expect(report.byStatus['draft']).toHaveLength(1);
  });

  it('reportText includes Active Campaigns section', async () => {
    const campaigns = [makeCampaign({ status: 'active' })];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.reportText).toContain('Active Campaigns');
  });

  it('reportText includes Completed Campaigns section when any exist', async () => {
    const campaigns = [makeCampaign({ id: 'c1', status: 'completed' })];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.reportText).toContain('Completed Campaigns');
  });

  it('includes comparison of active vs completed in report text when both exist', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', status: 'active', metrics: { sent: 100, opened: 50, replied: 30, converted: 5 } }),
      makeCampaign({ id: 'c2', status: 'completed', metrics: { sent: 100, opened: 30, replied: 10, converted: 2 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    // active reply rate 30% > completed reply rate 10% => outperforming
    expect(report.reportText.toLowerCase()).toMatch(/outperform|underperform/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Identify top-performing and underperforming campaigns
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Identify top-performing and underperforming campaigns', () => {
  it('identifies top performer as campaign with highest reply rate', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', name: 'Low', metrics: { sent: 100, opened: 10, replied: 5, converted: 1 } }),
      makeCampaign({ id: 'c2', name: 'High', metrics: { sent: 100, opened: 50, replied: 40, converted: 10 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.topPerformer?.name).toBe('High');
  });

  it('identifies needs attention as campaign with lowest reply rate with at least 1 sent', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', name: 'Low', metrics: { sent: 100, opened: 10, replied: 5, converted: 1 } }),
      makeCampaign({ id: 'c2', name: 'High', metrics: { sent: 100, opened: 50, replied: 40, converted: 10 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.needsAttention?.name).toBe('Low');
  });

  it('includes top performer in reportText', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', name: 'Winner', metrics: { sent: 100, opened: 50, replied: 40, converted: 10 } }),
      makeCampaign({ id: 'c2', name: 'Loser', metrics: { sent: 100, opened: 10, replied: 5, converted: 1 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.reportText).toContain('Top Performer');
    expect(report.reportText).toContain('Winner');
  });

  it('includes needs attention in reportText', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', name: 'Winner', metrics: { sent: 100, opened: 50, replied: 40, converted: 10 } }),
      makeCampaign({ id: 'c2', name: 'Loser', metrics: { sent: 100, opened: 10, replied: 5, converted: 1 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.reportText).toContain('Needs Attention');
    expect(report.reportText).toContain('Loser');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle campaigns with no sends
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle campaigns with no sends', () => {
  it('sets reply rate to 0 for campaigns with 0 sent', async () => {
    const campaign = makeCampaign({ metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } });
    const client = makeMockClient([campaign]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.campaigns[0].replyRate).toBe(0);
  });

  it('sets open rate to 0 for campaigns with 0 sent', async () => {
    const campaign = makeCampaign({ metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } });
    const client = makeMockClient([campaign]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.campaigns[0].openRate).toBe(0);
  });

  it('sets conversion rate to 0 for campaigns with 0 sent', async () => {
    const campaign = makeCampaign({ metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } });
    const client = makeMockClient([campaign]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.campaigns[0].conversionRate).toBe(0);
  });

  it('marks no-send campaign as "no data yet" in reportText', async () => {
    const campaign = makeCampaign({ name: 'Empty Draft', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } });
    const client = makeMockClient([campaign]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.reportText).toContain('no data yet');
  });

  it('excludes no-send campaigns from average calculations', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', name: 'Real', metrics: { sent: 100, opened: 40, replied: 20, converted: 5 } }),
      makeCampaign({ id: 'c2', name: 'Empty', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    // Only 'Real' should factor into average: reply rate = 20%
    expect(report.overallAverages.replyRate).toBe(20);
  });

  it('excludes no-send campaigns from top/needs attention identification', async () => {
    const campaign = makeCampaign({ name: 'No Data', metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } });
    const client = makeMockClient([campaign]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.topPerformer).toBeNull();
    expect(report.needsAttention).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle zero campaigns
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle zero campaigns', () => {
  it('outputs message when no campaigns exist', async () => {
    const client = makeMockClient([]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.reportText).toContain('No campaigns found in GojiBerry');
  });

  it('returns empty campaigns array when no campaigns exist', async () => {
    const client = makeMockClient([]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.campaigns).toHaveLength(0);
  });

  it('returns null topPerformer when no campaigns exist', async () => {
    const client = makeMockClient([]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.topPerformer).toBeNull();
  });

  it('returns null needsAttention when no campaigns exist', async () => {
    const client = makeMockClient([]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.needsAttention).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle API authentication failure
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle API authentication failure', () => {
  it('throws AuthError when API key is invalid', async () => {
    const client = makeMockClientThrowing(new AuthError());
    await expect(analyzeCampaignPerformance({ _client: client })).rejects.toThrow(AuthError);
  });

  it('does not output partial report on AuthError', async () => {
    const client = makeMockClientThrowing(new AuthError());
    let report;
    try {
      report = await analyzeCampaignPerformance({ _client: client });
    } catch {
      // expected
    }
    expect(report).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate trend insights from completed campaigns
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate trend insights from completed campaigns', () => {
  it('sets trend to improving when latest completed outperforms average', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', status: 'completed', updatedAt: '2026-01-01T00:00:00Z', metrics: { sent: 100, opened: 10, replied: 10, converted: 1 } }),
      makeCampaign({ id: 'c2', status: 'completed', updatedAt: '2026-02-01T00:00:00Z', metrics: { sent: 100, opened: 10, replied: 10, converted: 1 } }),
      makeCampaign({ id: 'c3', status: 'completed', updatedAt: '2026-03-01T00:00:00Z', metrics: { sent: 100, opened: 50, replied: 40, converted: 10 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.trend).toBe('improving');
  });

  it('sets trend to declining when latest completed underperforms average', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', status: 'completed', updatedAt: '2026-01-01T00:00:00Z', metrics: { sent: 100, opened: 50, replied: 40, converted: 10 } }),
      makeCampaign({ id: 'c2', status: 'completed', updatedAt: '2026-02-01T00:00:00Z', metrics: { sent: 100, opened: 50, replied: 40, converted: 10 } }),
      makeCampaign({ id: 'c3', status: 'completed', updatedAt: '2026-03-01T00:00:00Z', metrics: { sent: 100, opened: 10, replied: 5, converted: 1 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.trend).toBe('declining');
  });

  it('sets trend to stable when latest completed matches average closely', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', status: 'completed', updatedAt: '2026-01-01T00:00:00Z', metrics: { sent: 100, opened: 20, replied: 20, converted: 2 } }),
      makeCampaign({ id: 'c2', status: 'completed', updatedAt: '2026-02-01T00:00:00Z', metrics: { sent: 100, opened: 20, replied: 20, converted: 2 } }),
      makeCampaign({ id: 'c3', status: 'completed', updatedAt: '2026-03-01T00:00:00Z', metrics: { sent: 100, opened: 20, replied: 20, converted: 2 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.trend).toBe('stable');
  });

  it('includes trend line indicator in reportText', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', status: 'completed', metrics: { sent: 100, opened: 20, replied: 20, converted: 2 } }),
      makeCampaign({ id: 'c2', status: 'completed', metrics: { sent: 100, opened: 20, replied: 20, converted: 2 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.reportText).toContain('Trend');
    expect(report.reportText.toLowerCase()).toMatch(/improving|declining|stable/);
  });

  it('sets trend to insufficient_data when fewer than 2 completed campaigns', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', status: 'completed', metrics: { sent: 100, opened: 20, replied: 20, converted: 2 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.trend).toBe('insufficient_data');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Single campaign exists
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Single campaign exists', () => {
  it('outputs metrics for single campaign', async () => {
    const campaign = makeCampaign({ name: 'Solo', metrics: { sent: 50, opened: 20, replied: 10, converted: 2 } });
    const client = makeMockClient([campaign]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.campaigns).toHaveLength(1);
    expect(report.campaigns[0].replyRate).toBe(20);
  });

  it('skips comparative analysis for single campaign (no top/needs attention distinction)', async () => {
    const campaign = makeCampaign({ name: 'Solo', metrics: { sent: 50, opened: 20, replied: 10, converted: 2 } });
    const client = makeMockClient([campaign]);
    const report = await analyzeCampaignPerformance({ _client: client });
    // With only 1 campaign, top performer and needs attention are both the same or skipped
    // Spec says skip comparative — topPerformer may be set but needsAttention should be null (no peers)
    expect(report.needsAttention).toBeNull();
  });

  it('sets trend to insufficient_data for single campaign', async () => {
    const campaign = makeCampaign({ name: 'Solo', status: 'completed', metrics: { sent: 50, opened: 20, replied: 10, converted: 2 } });
    const client = makeMockClient([campaign]);
    const report = await analyzeCampaignPerformance({ _client: client });
    expect(report.trend).toBe('insufficient_data');
  });
});
