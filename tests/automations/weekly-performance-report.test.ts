import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateWeeklyReport } from '../../src/automations/weekly-performance-report.js';
import type { WeeklySnapshot } from '../../src/automations/weekly-performance-report.js';
import { AuthError } from '../../src/api/errors.js';
import type { Campaign } from '../../src/api/types.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'camp-1',
    name: 'Test Campaign',
    status: 'active',
    metrics: { sent: 100, opened: 40, replied: 10, converted: 5 },
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

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wpr-test-'));
}

function writeSnapshot(dir: string, snapshot: WeeklySnapshot): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${snapshot.date}.json`), JSON.stringify(snapshot, null, 2));
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate a weekly report with campaign metrics and recommendations
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate a weekly report with campaign metrics and recommendations', () => {
  it('calls getCampaigns to pull campaign data', async () => {
    const client = makeMockClient([makeCampaign()]);
    await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(client.getCampaigns).toHaveBeenCalledTimes(1);
  });

  it('returns currentWeek CampaignReport with campaigns', async () => {
    const client = makeMockClient([makeCampaign({ name: 'Alpha' })]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.currentWeek.campaigns.length).toBeGreaterThan(0);
    expect(report.currentWeek.campaigns[0].name).toBe('Alpha');
  });

  it('generates up to 3 recommendations', async () => {
    const client = makeMockClient([makeCampaign()]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.recommendations.length).toBeLessThanOrEqual(3);
  });

  it('outputs a reportText string', async () => {
    const client = makeMockClient([makeCampaign()]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(typeof report.reportText).toBe('string');
    expect(report.reportText.length).toBeGreaterThan(0);
  });

  it('reportText contains Weekly Performance Report header', async () => {
    const client = makeMockClient([makeCampaign()]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.reportText).toContain('Weekly Performance Report');
  });

  it('includes snapshot in returned report', async () => {
    const client = makeMockClient([makeCampaign()]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.snapshot).toBeDefined();
    expect(typeof report.snapshot.date).toBe('string');
    expect(typeof report.snapshot.avgReplyRate).toBe('number');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: First run with no previous report (no week-over-week comparison)
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: First run with no previous report', () => {
  it('sets previousWeek to null when no snapshot exists', async () => {
    const client = makeMockClient([makeCampaign()]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.previousWeek).toBeNull();
  });

  it('sets all deltas to null on first run', async () => {
    const client = makeMockClient([makeCampaign()]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.deltas.replyRate).toBeNull();
    expect(report.deltas.openRate).toBeNull();
    expect(report.deltas.sentChange).toBeNull();
  });

  it('reportText indicates first report when no previous snapshot', async () => {
    const client = makeMockClient([makeCampaign()]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.reportText).toContain('first report');
  });

  it('still generates recommendations based on absolute metrics on first run', async () => {
    // Overall reply rate < 3% → recommendation fires
    const client = makeMockClient([
      makeCampaign({ metrics: { sent: 100, opened: 10, replied: 2, converted: 0 } }),
    ]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.recommendations.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Week-over-week reply rate improved
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Week-over-week reply rate improved', () => {
  it('computes positive reply rate delta when current exceeds previous', async () => {
    const tmpDir = makeTmpDir();
    const prevSnapshot: WeeklySnapshot = {
      date: '2026-04-06',
      avgReplyRate: 4.2,
      avgOpenRate: 20,
      totalSent: 100,
      totalReplied: 4,
      campaignCount: 1,
    };
    writeSnapshot(tmpDir, prevSnapshot);

    // Current week: ~6.1% reply rate
    const client = makeMockClient([
      makeCampaign({ metrics: { sent: 100, opened: 30, replied: 6, converted: 2 } }),
    ]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: tmpDir });
    expect(report.deltas.replyRate).not.toBeNull();
    expect(report.deltas.replyRate!).toBeGreaterThan(0);
  });

  it('reportText shows reply rate delta with +pp format when improving', async () => {
    const tmpDir = makeTmpDir();
    writeSnapshot(tmpDir, {
      date: '2026-04-06',
      avgReplyRate: 4.2,
      avgOpenRate: 20,
      totalSent: 100,
      totalReplied: 4,
      campaignCount: 1,
    });
    const client = makeMockClient([
      makeCampaign({ metrics: { sent: 100, opened: 30, replied: 6, converted: 2 } }),
    ]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: tmpDir });
    expect(report.reportText).toMatch(/\+\d+(\.\d+)?pp/);
    expect(report.reportText.toLowerCase()).toContain('improving');
  });

  it('sets previousWeek to loaded snapshot when snapshot exists', async () => {
    const tmpDir = makeTmpDir();
    const prev: WeeklySnapshot = {
      date: '2026-04-06',
      avgReplyRate: 4.2,
      avgOpenRate: 20,
      totalSent: 100,
      totalReplied: 4,
      campaignCount: 1,
    };
    writeSnapshot(tmpDir, prev);
    const client = makeMockClient([makeCampaign()]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: tmpDir });
    expect(report.previousWeek).not.toBeNull();
    expect(report.previousWeek!.avgReplyRate).toBe(4.2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Week-over-week reply rate declined
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Week-over-week reply rate declined', () => {
  it('computes negative reply rate delta when current is below previous', async () => {
    const tmpDir = makeTmpDir();
    writeSnapshot(tmpDir, {
      date: '2026-04-06',
      avgReplyRate: 6.1,
      avgOpenRate: 30,
      totalSent: 100,
      totalReplied: 6,
      campaignCount: 1,
    });
    const client = makeMockClient([
      makeCampaign({ metrics: { sent: 100, opened: 20, replied: 4, converted: 1 } }),
    ]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: tmpDir });
    expect(report.deltas.replyRate).not.toBeNull();
    expect(report.deltas.replyRate!).toBeLessThan(0);
  });

  it('reportText shows declining indicator when reply rate dropped', async () => {
    const tmpDir = makeTmpDir();
    writeSnapshot(tmpDir, {
      date: '2026-04-06',
      avgReplyRate: 6.1,
      avgOpenRate: 30,
      totalSent: 100,
      totalReplied: 6,
      campaignCount: 1,
    });
    const client = makeMockClient([
      makeCampaign({ metrics: { sent: 100, opened: 20, replied: 4, converted: 1 } }),
    ]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: tmpDir });
    expect(report.reportText.toLowerCase()).toContain('declining');
  });

  it('reportText shows negative pp delta when declining', async () => {
    const tmpDir = makeTmpDir();
    writeSnapshot(tmpDir, {
      date: '2026-04-06',
      avgReplyRate: 6.1,
      avgOpenRate: 30,
      totalSent: 100,
      totalReplied: 6,
      campaignCount: 1,
    });
    const client = makeMockClient([
      makeCampaign({ metrics: { sent: 100, opened: 20, replied: 4, converted: 1 } }),
    ]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: tmpDir });
    // Should contain a negative delta like "−2.1pp" or "-2.1pp"
    expect(report.reportText).toMatch(/[−\-]\d+(\.\d+)?pp/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: No campaigns have sends this week
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: No campaigns have sends this week', () => {
  it('outputs "No outreach activity this week" when all campaigns have 0 sends', async () => {
    const client = makeMockClient([
      makeCampaign({ metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.reportText).toContain('No outreach activity this week');
  });

  it('recommends launching or checking stalled campaigns when no sends', async () => {
    const client = makeMockClient([
      makeCampaign({ metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    const allText = report.recommendations.join(' ') + report.reportText;
    expect(allText.toLowerCase()).toContain('launch a campaign or check if active campaigns are stalled');
  });

  it('returns report with 0 totalSent in snapshot when no sends', async () => {
    const client = makeMockClient([
      makeCampaign({ metrics: { sent: 0, opened: 0, replied: 0, converted: 0 } }),
    ]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.snapshot.totalSent).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Zero campaigns exist
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Zero campaigns exist', () => {
  it('outputs "No campaigns found" when GojiBerry returns no campaigns', async () => {
    const client = makeMockClient([]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.reportText).toContain('No campaigns found');
  });

  it('returns empty recommendations when no campaigns exist', async () => {
    const client = makeMockClient([]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.recommendations).toHaveLength(0);
  });

  it('returns empty campaigns array in currentWeek when no campaigns exist', async () => {
    const client = makeMockClient([]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.currentWeek.campaigns).toHaveLength(0);
  });

  it('snapshot has 0 campaignCount when no campaigns exist', async () => {
    const client = makeMockClient([]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.snapshot.campaignCount).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate recommendations from campaign patterns
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate recommendations from campaign patterns', () => {
  it('recommends doubling down when top campaign has 2x+ average reply rate', async () => {
    // avg = (40 + 4) / 2 = 22%, top = 40% → 40 >= 2*22? No. 40 >= 44? No.
    // Let's make it: top=50%, other=10% → avg=30%, 50 >= 2*30=60? No.
    // top=80%, other=10% → avg=45%, 80 >= 2*45=90? No.
    // top=90%, other=10% → avg=50%, 90 >= 2*50=100? No.
    // top=60%, avg=20% (one campaign has 60, one has 0 sends → avg=60? No)
    // Need: top is 2x+ the overall average
    // If we have campaigns: [60% reply rate, 20% reply rate]
    // avg = (60+20)/2 = 40%. 60 >= 2*40=80? No.
    // [60% reply rate, 10% reply rate]
    // avg = (60+10)/2 = 35%. 60 >= 2*35=70? No.
    // [80%, 10%] avg=45%. 80 >= 90? No.
    // [80%, 5%] avg=42.5%. 80 >= 85? No.
    // [90%, 5%] avg=47.5%. 90 >= 95? No.
    // Hmm, this is hard with 2 campaigns. Let me try with 3:
    // [80%, 5%, 5%] avg=30%. 80 >= 60? YES!
    const campaigns = [
      makeCampaign({ id: 'c1', name: 'Star Campaign', status: 'active', metrics: { sent: 100, opened: 80, replied: 80, converted: 5 } }), // 80% reply
      makeCampaign({ id: 'c2', name: 'Avg 1', status: 'active', metrics: { sent: 100, opened: 10, replied: 5, converted: 0 } }), // 5% reply
      makeCampaign({ id: 'c3', name: 'Avg 2', status: 'active', metrics: { sent: 100, opened: 10, replied: 5, converted: 0 } }), // 5% reply
    ];
    // avg reply = (80+5+5)/3 = 30%, top = 80%, 80 >= 2*30=60 ✓
    const client = makeMockClient(campaigns);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    const allRecs = report.recommendations.join('\n');
    expect(allRecs.toLowerCase()).toContain('double down');
    expect(allRecs).toContain('Star Campaign');
  });

  it('recommends pausing when active campaign has 0 replies after 20+ sends', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', name: 'Dead Campaign', status: 'active', metrics: { sent: 25, opened: 5, replied: 0, converted: 0 } }),
      makeCampaign({ id: 'c2', name: 'Normal', status: 'active', metrics: { sent: 100, opened: 40, replied: 15, converted: 3 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    const allRecs = report.recommendations.join('\n');
    expect(allRecs.toLowerCase()).toContain("isn't getting replies");
    expect(allRecs).toContain('Dead Campaign');
  });

  it('recommends reviewing ICP when overall reply rate is below 3%', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', metrics: { sent: 100, opened: 10, replied: 2, converted: 0 } }), // 2%
    ];
    const client = makeMockClient(campaigns);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    const allRecs = report.recommendations.join('\n');
    expect(allRecs.toLowerCase()).toContain('reply rates are low');
  });

  it('caps recommendations at 3', async () => {
    // Trigger all 3 patterns:
    // 1. Top 2x+ avg: [80%, 5%, 5%] → avg=30%, 80>=60 ✓
    // 2. Active 0 replies after 20+ sends: add a stalled campaign
    // 3. Overall < 3%: won't fire because avg=30%. Let's just rely on 1+2 and verify cap
    const campaigns = [
      makeCampaign({ id: 'c1', name: 'Star', status: 'active', metrics: { sent: 100, opened: 80, replied: 80, converted: 5 } }),
      makeCampaign({ id: 'c2', name: 'Stalled A', status: 'active', metrics: { sent: 25, opened: 5, replied: 0, converted: 0 } }),
      makeCampaign({ id: 'c3', name: 'Stalled B', status: 'active', metrics: { sent: 25, opened: 5, replied: 0, converted: 0 } }),
      makeCampaign({ id: 'c4', name: 'Stalled C', status: 'active', metrics: { sent: 25, opened: 5, replied: 0, converted: 0 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    expect(report.recommendations.length).toBeLessThanOrEqual(3);
  });

  it('does not recommend pausing for active campaign with fewer than 20 sends', async () => {
    const campaigns = [
      makeCampaign({ id: 'c1', name: 'New Campaign', status: 'active', metrics: { sent: 10, opened: 0, replied: 0, converted: 0 } }),
      makeCampaign({ id: 'c2', name: 'Normal', status: 'active', metrics: { sent: 100, opened: 40, replied: 15, converted: 3 } }),
    ];
    const client = makeMockClient(campaigns);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    const allRecs = report.recommendations.join('\n');
    expect(allRecs).not.toContain('New Campaign');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Store weekly snapshot for future comparison
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Store weekly snapshot for future comparison', () => {
  it('saves a snapshot file to the snapshotDir after report runs', async () => {
    const tmpDir = makeTmpDir();
    const client = makeMockClient([makeCampaign()]);
    await generateWeeklyReport({ _client: client, _snapshotDir: tmpDir });
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('saved snapshot contains required fields', async () => {
    const tmpDir = makeTmpDir();
    const client = makeMockClient([
      makeCampaign({ metrics: { sent: 100, opened: 40, replied: 10, converted: 2 } }),
    ]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: tmpDir });
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8')) as WeeklySnapshot;
    expect(saved.date).toBeDefined();
    expect(saved.avgReplyRate).toBeDefined();
    expect(saved.avgOpenRate).toBeDefined();
    expect(saved.totalSent).toBeDefined();
    expect(saved.totalReplied).toBeDefined();
    expect(saved.campaignCount).toBeDefined();
  });

  it('snapshot avgReplyRate matches campaign data', async () => {
    const tmpDir = makeTmpDir();
    const client = makeMockClient([
      makeCampaign({ metrics: { sent: 100, opened: 40, replied: 10, converted: 2 } }), // 10% reply
    ]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: tmpDir });
    expect(report.snapshot.avgReplyRate).toBe(10);
    expect(report.snapshot.totalSent).toBe(100);
    expect(report.snapshot.totalReplied).toBe(10);
  });

  it('loads previous snapshot for week-over-week comparison on subsequent run', async () => {
    const tmpDir = makeTmpDir();

    // Run 1: save a snapshot
    const client1 = makeMockClient([makeCampaign({ metrics: { sent: 100, opened: 40, replied: 10, converted: 2 } })]);
    const report1 = await generateWeeklyReport({ _client: client1, _snapshotDir: tmpDir });
    expect(report1.previousWeek).toBeNull();

    // Rename the snapshot file to yesterday's date so it's picked up as previous
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
    fs.renameSync(path.join(tmpDir, files[0]), path.join(tmpDir, `${yesterdayStr}.json`));

    // Run 2: should load previous snapshot
    const client2 = makeMockClient([makeCampaign({ metrics: { sent: 120, opened: 50, replied: 15, converted: 3 } })]);
    const report2 = await generateWeeklyReport({ _client: client2, _snapshotDir: tmpDir });
    expect(report2.previousWeek).not.toBeNull();
    expect(report2.previousWeek!.avgReplyRate).toBe(10);
  });

  it('snapshot campaignCount matches the number of campaigns returned', async () => {
    const tmpDir = makeTmpDir();
    const client = makeMockClient([
      makeCampaign({ id: 'c1' }),
      makeCampaign({ id: 'c2' }),
      makeCampaign({ id: 'c3' }),
    ]);
    const report = await generateWeeklyReport({ _client: client, _snapshotDir: tmpDir });
    expect(report.snapshot.campaignCount).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle API authentication failure
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle API authentication failure', () => {
  it('throws AuthError when API key is invalid', async () => {
    const client = makeMockClientThrowing(new AuthError());
    await expect(
      generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() }),
    ).rejects.toThrow(AuthError);
  });

  it('does not output a partial report on AuthError', async () => {
    const client = makeMockClientThrowing(new AuthError());
    let report;
    try {
      report = await generateWeeklyReport({ _client: client, _snapshotDir: makeTmpDir() });
    } catch {
      // expected
    }
    expect(report).toBeUndefined();
  });

  it('does not save a snapshot when AuthError is thrown', async () => {
    const tmpDir = makeTmpDir();
    const client = makeMockClientThrowing(new AuthError());
    try {
      await generateWeeklyReport({ _client: client, _snapshotDir: tmpDir });
    } catch {
      // expected
    }
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Schedule weekly report via cron
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Schedule weekly report via cron', () => {
  it('generateWeeklyReport is exported and callable', async () => {
    expect(typeof generateWeeklyReport).toBe('function');
  });

  it('lookbackDays option is accepted without error', async () => {
    const client = makeMockClient([makeCampaign()]);
    const report = await generateWeeklyReport({
      _client: client,
      _snapshotDir: makeTmpDir(),
      lookbackDays: 7,
    });
    expect(report).toBeDefined();
  });
});
