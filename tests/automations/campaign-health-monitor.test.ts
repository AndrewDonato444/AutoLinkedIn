import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkCampaignHealth } from '../../src/automations/campaign-health-monitor.js';
import type { HealthSnapshot } from '../../src/automations/campaign-health-monitor.js';
import { AuthError } from '../../src/api/errors.js';
import type { Campaign } from '../../src/api/types.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: `camp-${Math.random().toString(36).slice(2)}`,
    name: 'Test Campaign',
    status: 'active',
    metrics: { sent: 50, opened: 20, replied: 5, converted: 1 },
    updatedAt: daysAgoIso(1),
    ...overrides,
  };
}

type MockClient = { getCampaigns: ReturnType<typeof vi.fn> };

function makeClient(campaigns: Campaign[]): MockClient {
  return { getCampaigns: vi.fn().mockResolvedValue(campaigns) };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'health-test-'));
}

function writeSnapshot(dir: string, snapshot: HealthSnapshot): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${snapshot.date}.json`),
    JSON.stringify(snapshot, null, 2),
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: All active campaigns are healthy
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: All active campaigns are healthy', () => {
  const campaigns = [
    makeCampaign({
      id: 'c1',
      name: 'Q2 Outreach',
      metrics: { sent: 30, opened: 15, replied: 3, converted: 1 },
      updatedAt: daysAgoIso(1),
    }),
    makeCampaign({
      id: 'c2',
      name: 'Series A Batch',
      metrics: { sent: 20, opened: 10, replied: 2, converted: 0 },
      updatedAt: daysAgoIso(2),
    }),
  ];

  it('returns zero alerts when all campaigns are healthy', async () => {
    const client = makeClient(campaigns);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });
    expect(report.alerts).toHaveLength(0);
  });

  it('reportText contains "All campaigns healthy — no issues detected"', async () => {
    const client = makeClient(campaigns);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });
    expect(report.reportText).toContain('All campaigns healthy — no issues detected');
  });

  it('saves a health snapshot to the snapshot directory', async () => {
    const tmpDir = makeTmpDir();
    const client = makeClient(campaigns);
    await checkCampaignHealth({
      _client: client,
      _snapshotDir: tmpDir,
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('campaignsChecked equals number of active campaigns', async () => {
    const client = makeClient(campaigns);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
    });
    expect(report.campaignsChecked).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Detect a stalled campaign with no recent activity
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Detect a stalled campaign with no recent activity', () => {
  it('flags campaign as stalled when last send exceeds threshold', async () => {
    const campaign = makeCampaign({
      id: 'stall-1',
      name: 'Series A Founders Q2',
      metrics: { sent: 50, opened: 20, replied: 5, converted: 1 },
      updatedAt: daysAgoIso(5), // 5 days ago, threshold is 3
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    const stallAlerts = report.alerts.filter((a) => a.type === 'stalled');
    expect(stallAlerts).toHaveLength(1);
  });

  it('stall alert message mentions campaign name and days', async () => {
    const campaign = makeCampaign({
      id: 'stall-2',
      name: 'Series A Founders Q2',
      metrics: { sent: 50, opened: 20, replied: 5, converted: 1 },
      updatedAt: daysAgoIso(5),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    const stallAlert = report.alerts.find((a) => a.type === 'stalled');
    expect(stallAlert?.message).toContain('Series A Founders Q2');
    expect(stallAlert?.message).toMatch(/\d+ days/);
  });

  it('stall alert severity is "warning"', async () => {
    const campaign = makeCampaign({
      name: 'Stalled Campaign',
      updatedAt: daysAgoIso(4),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
    });

    const stallAlert = report.alerts.find((a) => a.type === 'stalled');
    expect(stallAlert?.severity).toBe('warning');
  });

  it('does not flag campaign as stalled when last send is within threshold', async () => {
    const campaign = makeCampaign({
      name: 'Active Campaign',
      metrics: { sent: 30, opened: 10, replied: 3, converted: 0 },
      updatedAt: daysAgoIso(1), // 1 day ago, threshold is 3
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    const stallAlerts = report.alerts.filter((a) => a.type === 'stalled');
    expect(stallAlerts).toHaveLength(0);
  });

  it('does not flag stall when updatedAt is absent', async () => {
    const campaign = makeCampaign({
      name: 'No Date Campaign',
      updatedAt: undefined,
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
    });

    const stallAlerts = report.alerts.filter((a) => a.type === 'stalled');
    expect(stallAlerts).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Detect a campaign with a low reply rate
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Detect a campaign with a low reply rate', () => {
  it('flags campaign as low reply rate when below threshold', async () => {
    const campaign = makeCampaign({
      id: 'low-1',
      name: 'Cold Outreach Batch 3',
      metrics: { sent: 25, opened: 5, replied: 0, converted: 0 }, // 0% reply (well below 2%)
      updatedAt: daysAgoIso(1),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    const lowRateAlerts = report.alerts.filter((a) => a.type === 'low_reply_rate');
    expect(lowRateAlerts).toHaveLength(1);
  });

  it('low reply rate alert message contains campaign name, rate, and sends', async () => {
    const campaign = makeCampaign({
      id: 'low-2',
      name: 'Cold Outreach Batch 3',
      // 0.8% reply rate: 2 replied out of 250 sent
      metrics: { sent: 250, opened: 30, replied: 2, converted: 0 },
      updatedAt: daysAgoIso(1),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    const lowAlert = report.alerts.find((a) => a.type === 'low_reply_rate');
    expect(lowAlert?.message).toContain('Cold Outreach Batch 3');
    expect(lowAlert?.message).toContain('250');
  });

  it('low reply rate alert severity is "warning"', async () => {
    const campaign = makeCampaign({
      metrics: { sent: 20, opened: 5, replied: 0, converted: 0 },
      updatedAt: daysAgoIso(1),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    const lowAlert = report.alerts.find((a) => a.type === 'low_reply_rate');
    expect(lowAlert?.severity).toBe('warning');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Skip reply rate check for campaigns with too few sends
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Skip reply rate check for campaigns with too few sends', () => {
  it('does not flag low reply rate when sends are below minSendsForAnalysis', async () => {
    const campaign = makeCampaign({
      id: 'early-1',
      name: 'New Test Campaign',
      metrics: { sent: 3, opened: 1, replied: 0, converted: 0 },
      updatedAt: daysAgoIso(1),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    const lowRateAlerts = report.alerts.filter((a) => a.type === 'low_reply_rate');
    expect(lowRateAlerts).toHaveLength(0);
  });

  it('marks campaign as too early to evaluate with send counts', async () => {
    const campaign = makeCampaign({
      id: 'early-2',
      name: 'New Test Campaign',
      metrics: { sent: 3, opened: 1, replied: 0, converted: 0 },
      updatedAt: daysAgoIso(1),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    const status = report.campaignStatuses.find((s) => s.campaignId === 'early-2');
    expect(status?.status).toContain('too early');
    expect(status?.status).toContain('3');
    expect(status?.status).toContain('10');
  });

  it('reportText shows too early format for under-threshold campaigns', async () => {
    const campaign = makeCampaign({
      name: 'New Test Campaign',
      metrics: { sent: 3, opened: 1, replied: 0, converted: 0 },
      updatedAt: daysAgoIso(1),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    expect(report.reportText).toContain('too early');
    expect(report.reportText).toContain('3/10');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Detect multiple issues on the same campaign
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Detect multiple issues on the same campaign', () => {
  it('flags campaign with both stalled and low reply rate alerts', async () => {
    const campaign = makeCampaign({
      id: 'multi-1',
      name: 'Stale Outreach',
      metrics: { sent: 40, opened: 5, replied: 0, converted: 0 }, // 0% reply, well below 2%
      updatedAt: daysAgoIso(5), // 5 days, threshold is 3
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    const types = report.alerts.map((a) => a.type);
    expect(types).toContain('stalled');
    expect(types).toContain('low_reply_rate');
  });

  it('both alerts are for the same campaign', async () => {
    const campaign = makeCampaign({
      id: 'multi-2',
      name: 'Stale Outreach',
      metrics: { sent: 40, opened: 5, replied: 0, converted: 0 },
      updatedAt: daysAgoIso(5),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    const campaignAlerts = report.alerts.filter((a) => a.campaignId === 'multi-2');
    expect(campaignAlerts.length).toBeGreaterThanOrEqual(2);
  });

  it('campaignStatuses entry has both alerts', async () => {
    const campaign = makeCampaign({
      id: 'multi-3',
      name: 'Stale Outreach',
      metrics: { sent: 40, opened: 5, replied: 0, converted: 0 },
      updatedAt: daysAgoIso(5),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    const status = report.campaignStatuses.find((s) => s.campaignId === 'multi-3');
    const alertTypes = status?.alerts.map((a) => a.type) ?? [];
    expect(alertTypes).toContain('stalled');
    expect(alertTypes).toContain('low_reply_rate');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Zero active campaigns
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Zero active campaigns', () => {
  it('outputs message about no active campaigns when list is empty', async () => {
    const client = makeClient([]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
    });
    expect(report.reportText).toContain('No active campaigns to monitor');
  });

  it('returns empty health report with zero alerts', async () => {
    const client = makeClient([]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
    });
    expect(report.alerts).toHaveLength(0);
    expect(report.campaignsChecked).toBe(0);
  });

  it('outputs the GojiBerry launch suggestion when no campaigns exist at all', async () => {
    const client = makeClient([]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
    });
    expect(report.reportText).toContain('GojiBerry');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: All campaigns are drafts or paused
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: All campaigns are drafts or paused', () => {
  it('outputs message with paused and draft counts', async () => {
    const campaigns = [
      makeCampaign({ status: 'paused', name: 'Paused Camp 1' }),
      makeCampaign({ status: 'paused', name: 'Paused Camp 2' }),
      makeCampaign({ status: 'draft', name: 'Draft Camp 1' }),
    ];
    const client = makeClient(campaigns);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
    });
    expect(report.reportText).toContain('No active campaigns to monitor');
    expect(report.reportText).toContain('paused');
    expect(report.reportText).toContain('draft');
  });

  it('includes suggestion to resume or launch', async () => {
    const campaigns = [
      makeCampaign({ status: 'paused', name: 'Paused Camp' }),
      makeCampaign({ status: 'draft', name: 'Draft Camp' }),
    ];
    const client = makeClient(campaigns);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
    });
    expect(report.reportText).toContain('Resume');
  });

  it('returns zero alerts', async () => {
    const campaigns = [
      makeCampaign({ status: 'paused' }),
      makeCampaign({ status: 'draft' }),
    ];
    const client = makeClient(campaigns);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
    });
    expect(report.alerts).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle API authentication failure
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle API authentication failure', () => {
  it('throws AuthError when API key is invalid', async () => {
    const client = { getCampaigns: vi.fn().mockRejectedValue(new AuthError()) };
    await expect(
      checkCampaignHealth({ _client: client, _snapshotDir: makeTmpDir() }),
    ).rejects.toThrow(AuthError);
  });

  it('does not return a partial health report on AuthError', async () => {
    const client = { getCampaigns: vi.fn().mockRejectedValue(new AuthError()) };
    let report;
    try {
      report = await checkCampaignHealth({ _client: client, _snapshotDir: makeTmpDir() });
    } catch {
      // expected
    }
    expect(report).toBeUndefined();
  });

  it('does not save a snapshot when AuthError is thrown', async () => {
    const tmpDir = makeTmpDir();
    const client = { getCampaigns: vi.fn().mockRejectedValue(new AuthError()) };
    try {
      await checkCampaignHealth({ _client: client, _snapshotDir: tmpDir });
    } catch {
      // expected
    }
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Compare health across runs to detect deterioration
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Compare health across runs to detect deterioration', () => {
  it('flags campaign as declining when previously healthy but now low reply rate', async () => {
    const tmpDir = makeTmpDir();
    const prevSnapshot: HealthSnapshot = {
      date: '2026-04-10',
      campaigns: [
        { id: 'camp-decline', alerts: [], replyRate: 5.0, sent: 100 },
      ],
    };
    writeSnapshot(tmpDir, prevSnapshot);

    const campaign = makeCampaign({
      id: 'camp-decline',
      name: 'Declining Campaign',
      // Now has low reply rate: 1% (was 5%)
      metrics: { sent: 200, opened: 20, replied: 2, converted: 0 },
      updatedAt: daysAgoIso(1),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: tmpDir,
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    const types = report.alerts.map((a) => a.type);
    expect(types).toContain('declining');
    expect(types).toContain('low_reply_rate');
  });

  it('declining alert includes previous and current reply rates', async () => {
    const tmpDir = makeTmpDir();
    writeSnapshot(tmpDir, {
      date: '2026-04-10',
      campaigns: [{ id: 'camp-d2', alerts: [], replyRate: 5.0, sent: 100 }],
    });

    const campaign = makeCampaign({
      id: 'camp-d2',
      name: 'Declining Campaign',
      metrics: { sent: 200, opened: 20, replied: 2, converted: 0 }, // 1% reply
      updatedAt: daysAgoIso(1),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: tmpDir,
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    const decliningAlert = report.alerts.find((a) => a.type === 'declining');
    expect(decliningAlert?.message).toContain('5');
    expect(decliningAlert?.message).toContain('1');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Campaign recovers from previous alert
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Campaign recovers from previous alert', () => {
  it('marks campaign as recovered when previously stalled but now active', async () => {
    const tmpDir = makeTmpDir();
    writeSnapshot(tmpDir, {
      date: '2026-04-10',
      campaigns: [{ id: 'camp-recover', alerts: ['stalled'], replyRate: 10.0, sent: 50 }],
    });

    const campaign = makeCampaign({
      id: 'camp-recover',
      name: 'Rebound Campaign',
      metrics: { sent: 70, opened: 20, replied: 7, converted: 1 }, // 10% reply, healthy
      updatedAt: daysAgoIso(1), // recent send, not stalled
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: tmpDir,
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    const recoveryAlerts = report.recoveries;
    expect(recoveryAlerts.length).toBeGreaterThan(0);
    expect(recoveryAlerts[0].type).toBe('recovered');
  });

  it('recovery message mentions campaign name and previous stall', async () => {
    const tmpDir = makeTmpDir();
    writeSnapshot(tmpDir, {
      date: '2026-04-10',
      campaigns: [{ id: 'camp-rr', alerts: ['stalled'], replyRate: 10.0, sent: 50 }],
    });

    const campaign = makeCampaign({
      id: 'camp-rr',
      name: 'Rebound Campaign',
      metrics: { sent: 70, opened: 20, replied: 7, converted: 1 },
      updatedAt: daysAgoIso(1),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: tmpDir,
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    const recovery = report.recoveries[0];
    expect(recovery.message).toContain('Rebound Campaign');
    expect(recovery.message.toLowerCase()).toContain('stalled');
  });

  it('recovery appears in reportText', async () => {
    const tmpDir = makeTmpDir();
    writeSnapshot(tmpDir, {
      date: '2026-04-10',
      campaigns: [{ id: 'camp-rt', alerts: ['stalled'], replyRate: 8.0, sent: 40 }],
    });

    const campaign = makeCampaign({
      id: 'camp-rt',
      name: 'Rebound Campaign',
      metrics: { sent: 55, opened: 15, replied: 6, converted: 0 },
      updatedAt: daysAgoIso(1),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: tmpDir,
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    expect(report.reportText).toContain('Rebound Campaign');
    expect(report.reportText.toLowerCase()).toContain('recover');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Store health snapshot for future comparison
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Store health snapshot for future comparison', () => {
  it('saves snapshot file to snapshotDir after successful run', async () => {
    const tmpDir = makeTmpDir();
    const campaign = makeCampaign({ id: 'snap-1' });
    const client = makeClient([campaign]);
    await checkCampaignHealth({ _client: client, _snapshotDir: tmpDir });
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('snapshot contains required fields: date, campaigns array', async () => {
    const tmpDir = makeTmpDir();
    const campaign = makeCampaign({ id: 'snap-2' });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({ _client: client, _snapshotDir: tmpDir });

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8'),
    ) as HealthSnapshot;

    expect(saved.date).toBeDefined();
    expect(Array.isArray(saved.campaigns)).toBe(true);
  });

  it('snapshot campaigns include id, alerts, replyRate, sent', async () => {
    const tmpDir = makeTmpDir();
    const campaign = makeCampaign({
      id: 'snap-3',
      metrics: { sent: 40, opened: 10, replied: 4, converted: 0 },
    });
    const client = makeClient([campaign]);
    await checkCampaignHealth({ _client: client, _snapshotDir: tmpDir });

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8'),
    ) as HealthSnapshot;

    expect(saved.campaigns[0].id).toBeDefined();
    expect(Array.isArray(saved.campaigns[0].alerts)).toBe(true);
    expect(typeof saved.campaigns[0].replyRate).toBe('number');
    expect(typeof saved.campaigns[0].sent).toBe('number');
  });

  it('snapshot returned in report matches what was saved to disk', async () => {
    const tmpDir = makeTmpDir();
    const campaign = makeCampaign({ id: 'snap-4' });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({ _client: client, _snapshotDir: tmpDir });

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8'),
    ) as HealthSnapshot;

    expect(report.snapshot.date).toBe(saved.date);
    expect(report.snapshot.campaigns.length).toBe(saved.campaigns.length);
  });

  it('loads previous snapshot and compares on next run', async () => {
    const tmpDir = makeTmpDir();

    // Run 1: save initial snapshot
    const campaign = makeCampaign({
      id: 'snap-5',
      metrics: { sent: 30, opened: 10, replied: 3, converted: 0 },
      updatedAt: daysAgoIso(1),
    });
    const client1 = makeClient([campaign]);
    await checkCampaignHealth({
      _client: client1,
      _snapshotDir: tmpDir,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    // Rename to yesterday so it's picked up as previous
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    fs.renameSync(path.join(tmpDir, files[0]), path.join(tmpDir, `${yesterdayStr}.json`));

    // Run 2: campaign now has low reply rate (was healthy)
    const campaign2 = makeCampaign({
      id: 'snap-5',
      metrics: { sent: 100, opened: 10, replied: 1, converted: 0 }, // 1%, now below threshold
      updatedAt: daysAgoIso(1),
    });
    const client2 = makeClient([campaign2]);
    const report = await checkCampaignHealth({
      _client: client2,
      _snapshotDir: tmpDir,
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });

    // Should have detected the decline (was healthy, now low)
    const types = report.alerts.map((a) => a.type);
    expect(types).toContain('low_reply_rate');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Schedule campaign health monitor via cron
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Schedule campaign health monitor via cron', () => {
  it('checkCampaignHealth is exported and callable', () => {
    expect(typeof checkCampaignHealth).toBe('function');
  });

  it('runs successfully and returns a health report', async () => {
    const campaign = makeCampaign({
      metrics: { sent: 30, opened: 10, replied: 3, converted: 0 },
      updatedAt: daysAgoIso(1),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
    });
    expect(report).toBeDefined();
    expect(report.reportText.length).toBeGreaterThan(0);
  });

  it('reportText includes a next health check date', async () => {
    const campaign = makeCampaign({
      metrics: { sent: 30, opened: 10, replied: 3, converted: 0 },
      updatedAt: daysAgoIso(1),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
    });
    expect(report.reportText).toContain('Next health check:');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Report text format
// ──────────────────────────────────────────────────────────────────────────────

describe('Report text format', () => {
  it('includes campaign health check header', async () => {
    const campaign = makeCampaign({ metrics: { sent: 20, opened: 5, replied: 2, converted: 0 } });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.reportText).toContain('Campaign Health Check');
  });

  it('includes status line with campaign count and alert count when alerts exist', async () => {
    const campaign = makeCampaign({
      metrics: { sent: 30, opened: 5, replied: 0, converted: 0 },
      updatedAt: daysAgoIso(5),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });
    expect(report.reportText).toContain('Status:');
    expect(report.reportText).toContain('active campaigns checked');
  });

  it('includes alerts section when there are alerts', async () => {
    const campaign = makeCampaign({
      metrics: { sent: 30, opened: 5, replied: 0, converted: 0 },
      updatedAt: daysAgoIso(5),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });
    expect(report.reportText).toContain('--- Alerts ---');
  });

  it('includes campaign summary section', async () => {
    const campaign = makeCampaign({ metrics: { sent: 20, opened: 5, replied: 2, converted: 0 } });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });
    expect(report.reportText).toContain('--- Campaign Summary ---');
  });

  it('includes what to do section when there are alerts', async () => {
    const campaign = makeCampaign({
      metrics: { sent: 30, opened: 5, replied: 0, converted: 0 },
      updatedAt: daysAgoIso(5),
    });
    const client = makeClient([campaign]);
    const report = await checkCampaignHealth({
      _client: client,
      _snapshotDir: makeTmpDir(),
      stallThresholdDays: 3,
      lowReplyRateThreshold: 2,
      minSendsForAnalysis: 10,
    });
    expect(report.reportText).toContain('--- What to Do ---');
  });
});
