import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateMorningBriefing } from '../../src/automations/morning-briefing.js';
import type { BriefingSnapshot } from '../../src/automations/morning-briefing.js';
import { AuthError } from '../../src/api/errors.js';
import type { Lead, Campaign, List, PaginatedLeads } from '../../src/api/types.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: `lead-${Math.random().toString(36).slice(2)}`,
    firstName: 'Jane',
    lastName: 'Doe',
    profileUrl: 'https://linkedin.com/in/jane-doe',
    company: 'FinPay',
    jobTitle: 'CEO',
    fitScore: 75,
    intentType: 'job_posting',
    intentSignals: ['Posted a job', 'Visited pricing page'],
    personalizedMessages: [],
    ...overrides,
  };
}

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'camp-1',
    name: 'Q1 Outreach',
    status: 'active',
    metrics: { sent: 50, opened: 20, replied: 5, converted: 1 },
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

// Mock searchLeads that respects scoreFrom/scoreTo filters (like real API)
function makeSearchLeadsMock(leads: Lead[]) {
  return vi.fn().mockImplementation(async (filters: Record<string, unknown> = {}) => {
    let filtered = leads;
    if (filters.scoreFrom != null) {
      filtered = filtered.filter((l) => (l.fitScore ?? 0) >= (filters.scoreFrom as number));
    }
    if (filters.scoreTo != null) {
      filtered = filtered.filter((l) => (l.fitScore ?? 0) <= (filters.scoreTo as number));
    }
    return paginatedWith(filtered, filtered.length);
  });
}

type MockClient = {
  searchLeads: ReturnType<typeof vi.fn>;
  getIntentTypeCounts: ReturnType<typeof vi.fn>;
  getCampaigns: ReturnType<typeof vi.fn>;
  getLists: ReturnType<typeof vi.fn>;
};

function makeMockClient(
  leads: Lead[],
  campaigns: Campaign[] = [makeCampaign()],
  lists: List[] = [makeList()],
): MockClient {
  return {
    searchLeads: makeSearchLeadsMock(leads),
    getIntentTypeCounts: vi.fn().mockResolvedValue({ job_posting: leads.length }),
    getCampaigns: vi.fn().mockResolvedValue(campaigns),
    getLists: vi.fn().mockResolvedValue(lists),
  };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbr-test-'));
}

function writeSnapshot(dir: string, snapshot: BriefingSnapshot): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${snapshot.date}.json`),
    JSON.stringify(snapshot, null, 2),
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Generate a complete morning briefing with pipeline and warm leads
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Generate a complete morning briefing with pipeline and warm leads', () => {
  const warmLeads = [
    makeLead({ id: 'l1', fitScore: 85, personalizedMessages: [] }),
    makeLead({ id: 'l2', fitScore: 70, personalizedMessages: [] }),
    makeLead({ id: 'l3', fitScore: 55, personalizedMessages: [] }),
  ];

  it('calls searchLeads to fetch pipeline and warm lead data', async () => {
    const client = makeMockClient(warmLeads);
    await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(client.searchLeads).toHaveBeenCalled();
  });

  it('calls getCampaigns and getLists for pipeline overview', async () => {
    const client = makeMockClient(warmLeads);
    await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(client.getCampaigns).toHaveBeenCalledTimes(1);
    expect(client.getLists).toHaveBeenCalledTimes(1);
  });

  it('returns a MorningBriefing with pipeline data', async () => {
    const client = makeMockClient(warmLeads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.pipeline).toBeDefined();
    expect(briefing.pipeline.contacts.total).toBe(3);
  });

  it('returns topLeads sorted by fitScore descending', async () => {
    const client = makeMockClient(warmLeads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.topLeads[0].fitScore).toBeGreaterThanOrEqual(briefing.topLeads[1]?.fitScore ?? 0);
  });

  it('briefingText opens with a pipeline summary line', async () => {
    const client = makeMockClient(warmLeads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.briefingText).toContain('Pipeline:');
    expect(briefing.briefingText).toContain('leads');
  });

  it('briefingText lists warm leads section', async () => {
    const client = makeMockClient(warmLeads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.briefingText).toContain('Leads Right Now');
    expect(briefing.briefingText).toContain('Jane');
  });

  it('briefingText ends with a next action', async () => {
    const client = makeMockClient(warmLeads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.briefingText).toContain('What to Do');
    expect(briefing.nextAction.length).toBeGreaterThan(0);
  });

  it('briefingText includes "Morning Briefing" header', async () => {
    const client = makeMockClient(warmLeads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.briefingText).toContain('Morning Briefing');
  });

  it('briefingText includes next briefing date', async () => {
    const client = makeMockClient(warmLeads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.briefingText).toContain('Next briefing:');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Briefing highlights overnight changes
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Briefing highlights overnight changes', () => {
  it('compares current pipeline totals to previous snapshot', async () => {
    const tmpDir = makeTmpDir();
    const prevSnapshot: BriefingSnapshot = {
      date: '2026-04-12',
      totalLeads: 2,
      byTier: { hot: 0, warm: 2, cool: 0, cold: 0, unscored: 0 },
      campaignCount: 1,
      topLeadIds: ['l1', 'l2'],
    };
    writeSnapshot(tmpDir, prevSnapshot);

    const leads = [
      makeLead({ id: 'l1', fitScore: 85 }),
      makeLead({ id: 'l2', fitScore: 70 }),
      makeLead({ id: 'l3', fitScore: 55 }), // new lead
    ];
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: tmpDir });
    expect(briefing.overnightChanges.newLeads).toBe(1);
    expect(briefing.overnightChanges.previousSnapshot).not.toBeNull();
  });

  it('briefingText reports new leads delta', async () => {
    const tmpDir = makeTmpDir();
    writeSnapshot(tmpDir, {
      date: '2026-04-12',
      totalLeads: 1,
      byTier: { hot: 1, warm: 0, cool: 0, cold: 0, unscored: 0 },
      campaignCount: 1,
      topLeadIds: ['l1'],
    });

    const leads = [
      makeLead({ id: 'l1', fitScore: 85 }),
      makeLead({ id: 'l2', fitScore: 70 }),
    ];
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: tmpDir });
    expect(briefing.briefingText).toContain('Overnight:');
    expect(briefing.briefingText).toContain('+1');
  });

  it('reports newlyWarm when leads crossed into warm tier since last briefing', async () => {
    const tmpDir = makeTmpDir();
    writeSnapshot(tmpDir, {
      date: '2026-04-12',
      totalLeads: 3,
      byTier: { hot: 0, warm: 1, cool: 2, cold: 0, unscored: 0 },
      campaignCount: 1,
      topLeadIds: [],
    });

    // Now 2 warm leads (1 more than before)
    const leads = [
      makeLead({ id: 'l1', fitScore: 85 }),
      makeLead({ id: 'l2', fitScore: 70 }),
      makeLead({ id: 'l3', fitScore: 25 }),
    ];
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: tmpDir });
    expect(briefing.overnightChanges.newlyWarm).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: First briefing with no previous snapshot
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: First briefing with no previous snapshot', () => {
  const leads = [
    makeLead({ id: 'l1', fitScore: 80 }),
    makeLead({ id: 'l2', fitScore: 65 }),
  ];

  it('sets previousSnapshot to null when no snapshot exists', async () => {
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.overnightChanges.previousSnapshot).toBeNull();
  });

  it('briefingText marks overnight section as first briefing', async () => {
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.briefingText).toContain('first briefing');
  });

  it('still lists top warm leads on first run', async () => {
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.topLeads.length).toBeGreaterThan(0);
  });

  it('still includes a next action on first run', async () => {
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.nextAction.length).toBeGreaterThan(0);
    expect(briefing.briefingText).toContain('What to Do');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Briefing with warm leads ready for outreach
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Briefing with warm leads ready for outreach', () => {
  it('counts leads with messages correctly', async () => {
    const leads = [
      makeLead({ id: 'l1', fitScore: 85, personalizedMessages: [{ content: 'Hi Jane, saw you posted a job...', stepNumber: 1 }] }),
      makeLead({ id: 'l2', fitScore: 70, personalizedMessages: [] }),
    ];
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.leadsWithMessages).toBe(1);
  });

  it('next action says to open GojiBerry to approve when messages are ready', async () => {
    const leads = [
      makeLead({ id: 'l1', fitScore: 85, personalizedMessages: [{ content: 'Hi Jane...', stepNumber: 1 }] }),
    ];
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.nextAction.toLowerCase()).toContain('messages ready');
    expect(briefing.nextAction.toLowerCase()).toContain('gojiberry');
  });

  it('briefingText flags leads with messages as "Messages ready — approve in GojiBerry"', async () => {
    const leads = [
      makeLead({ id: 'l1', fitScore: 85, personalizedMessages: [{ content: 'Hi Jane...', stepNumber: 1 }] }),
    ];
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.briefingText).toContain('Messages ready — approve in GojiBerry');
  });

  it('next action includes the count of leads with messages', async () => {
    const leads = [
      makeLead({ id: 'l1', fitScore: 85, personalizedMessages: [{ content: 'msg1', stepNumber: 1 }] }),
      makeLead({ id: 'l2', fitScore: 72, personalizedMessages: [{ content: 'msg2', stepNumber: 1 }] }),
    ];
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.nextAction).toContain('2');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Briefing with warm leads but no messages yet
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Briefing with warm leads but no messages yet', () => {
  it('leadsWithMessages is 0 when no leads have messages', async () => {
    const leads = [
      makeLead({ id: 'l1', fitScore: 85, personalizedMessages: [] }),
      makeLead({ id: 'l2', fitScore: 70, personalizedMessages: [] }),
    ];
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.leadsWithMessages).toBe(0);
  });

  it('lists warm leads normally in briefingText', async () => {
    const leads = [
      makeLead({ id: 'l1', fitScore: 80, personalizedMessages: [] }),
    ];
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.briefingText).toContain('Jane');
  });

  it('next action says to run message generation', async () => {
    const leads = [
      makeLead({ id: 'l1', fitScore: 80, personalizedMessages: [] }),
    ];
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.nextAction.toLowerCase()).toContain('messages');
    expect(briefing.nextAction.toLowerCase()).toContain('generation');
  });

  it('briefingText shows "Needs messages" per lead without personalizedMessages', async () => {
    const leads = [
      makeLead({ id: 'l1', fitScore: 80, personalizedMessages: [] }),
    ];
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.briefingText).toContain('Needs messages');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Empty pipeline — no leads, no campaigns
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Empty pipeline — no leads, no campaigns', () => {
  it('briefingText outputs empty pipeline message', async () => {
    const client = makeMockClient([], [], []);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.briefingText).toContain('pipeline is empty');
  });

  it('next action says to define ICP and run a lead scan', async () => {
    const client = makeMockClient([], [], []);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.nextAction.toLowerCase()).toContain('icp');
    expect(briefing.nextAction.toLowerCase()).toContain('scan');
  });

  it('returns briefing with zero-state content (zero pipeline totals)', async () => {
    const client = makeMockClient([], [], []);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.pipeline.contacts.total).toBe(0);
    expect(briefing.topLeads).toHaveLength(0);
    expect(briefing.totalWarmLeads).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Leads exist but none are warm
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Leads exist but none are warm', () => {
  it('pipeline summary shows total lead count', async () => {
    const coldLeads = [
      makeLead({ id: 'l1', fitScore: 10 }),
      makeLead({ id: 'l2', fitScore: 15 }),
      makeLead({ id: 'l3', fitScore: 30 }),
    ];
    const client = makeMockClient(coldLeads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.pipeline.contacts.total).toBe(3);
  });

  it('warm leads section says no warm leads with count and threshold', async () => {
    const coldLeads = [
      makeLead({ id: 'l1', fitScore: 10 }),
      makeLead({ id: 'l2', fitScore: 15 }),
    ];
    const client = makeMockClient(coldLeads);
    const briefing = await generateMorningBriefing({
      _client: client,
      _snapshotDir: makeTmpDir(),
    });
    expect(briefing.briefingText).toContain('No warm leads right now');
    expect(briefing.totalWarmLeads).toBe(0);
  });

  it('next action says to consider enriching more leads or adjusting ICP', async () => {
    const coldLeads = [makeLead({ id: 'l1', fitScore: 20 })];
    const client = makeMockClient(coldLeads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.nextAction.toLowerCase()).toContain('enriching');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Top leads are capped at configured limit
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Top leads are capped at configured limit', () => {
  it('includes only topLeadsCount leads when there are more warm leads', async () => {
    const leads = Array.from({ length: 10 }, (_, i) =>
      makeLead({ id: `l${i}`, fitScore: 80 - i }),
    );
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({
      _client: client,
      _snapshotDir: makeTmpDir(),
      topLeadsCount: 3,
    });
    expect(briefing.topLeads).toHaveLength(3);
  });

  it('notes remaining warm leads not shown', async () => {
    const leads = Array.from({ length: 10 }, (_, i) =>
      makeLead({ id: `l${i}`, fitScore: 80 - i }),
    );
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({
      _client: client,
      _snapshotDir: makeTmpDir(),
      topLeadsCount: 3,
    });
    expect(briefing.briefingText).toContain('more warm');
    expect(briefing.briefingText).toContain('not shown');
  });

  it('totalWarmLeads reflects the full warm count, not just top n', async () => {
    const leads = Array.from({ length: 10 }, (_, i) =>
      makeLead({ id: `l${i}`, fitScore: 80 - i }),
    );
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({
      _client: client,
      _snapshotDir: makeTmpDir(),
      topLeadsCount: 3,
    });
    expect(briefing.totalWarmLeads).toBe(10);
    expect(briefing.topLeads).toHaveLength(3);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle API authentication failure
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle API authentication failure', () => {
  it('throws AuthError when API key is invalid', async () => {
    const client = {
      searchLeads: vi.fn().mockRejectedValue(new AuthError()),
      getIntentTypeCounts: vi.fn().mockResolvedValue({}),
      getCampaigns: vi.fn().mockRejectedValue(new AuthError()),
      getLists: vi.fn().mockResolvedValue([]),
    };
    await expect(
      generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() }),
    ).rejects.toThrow(AuthError);
  });

  it('does not return a partial briefing on AuthError', async () => {
    const client = {
      searchLeads: vi.fn().mockRejectedValue(new AuthError()),
      getIntentTypeCounts: vi.fn().mockResolvedValue({}),
      getCampaigns: vi.fn().mockRejectedValue(new AuthError()),
      getLists: vi.fn().mockResolvedValue([]),
    };
    let briefing;
    try {
      briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    } catch {
      // expected
    }
    expect(briefing).toBeUndefined();
  });

  it('does not save a snapshot when AuthError is thrown', async () => {
    const tmpDir = makeTmpDir();
    const client = {
      searchLeads: vi.fn().mockRejectedValue(new AuthError()),
      getIntentTypeCounts: vi.fn().mockResolvedValue({}),
      getCampaigns: vi.fn().mockRejectedValue(new AuthError()),
      getLists: vi.fn().mockResolvedValue([]),
    };
    try {
      await generateMorningBriefing({ _client: client, _snapshotDir: tmpDir });
    } catch {
      // expected
    }
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Handle partial API failure (pipeline succeeds, warm leads fail)
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Handle partial API failure (pipeline succeeds, warm leads fail)', () => {
  function makePartialFailureClient(leads: Lead[], campaigns: Campaign[]): MockClient {
    return {
      // First call (no scoreFrom filter) → pipeline succeeds
      // Subsequent calls (with scoreFrom) → network error
      searchLeads: vi.fn().mockImplementation(async (filters: Record<string, unknown> = {}) => {
        if (filters.scoreFrom != null) throw new Error('ECONNRESET: network error');
        return paginatedWith(leads, leads.length);
      }),
      getIntentTypeCounts: vi.fn().mockResolvedValue({}),
      getCampaigns: vi.fn().mockResolvedValue(campaigns),
      getLists: vi.fn().mockResolvedValue([]),
    };
  }

  it('includes pipeline summary in briefing despite warm leads failure', async () => {
    const leads = [makeLead({ fitScore: 75 })];
    const client = makePartialFailureClient(leads, [makeCampaign()]);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.briefingText).toContain('Pipeline:');
    expect(briefing.pipeline.contacts.total).toBe(1);
  });

  it('marks warm leads section as unavailable', async () => {
    const leads = [makeLead({ fitScore: 75 })];
    const client = makePartialFailureClient(leads, [makeCampaign()]);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing.briefingText).toContain('Could not fetch warm leads');
  });

  it('still outputs a briefing (partial data is better than nothing)', async () => {
    const leads = [makeLead({ fitScore: 75 })];
    const client = makePartialFailureClient(leads, [makeCampaign()]);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing).toBeDefined();
    expect(typeof briefing.briefingText).toBe('string');
    expect(briefing.briefingText.length).toBeGreaterThan(0);
  });

  it('saves a snapshot even on partial failure', async () => {
    const tmpDir = makeTmpDir();
    const leads = [makeLead({ fitScore: 75 })];
    const client = makePartialFailureClient(leads, [makeCampaign()]);
    await generateMorningBriefing({ _client: client, _snapshotDir: tmpDir });
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Store briefing snapshot for overnight comparison
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Store briefing snapshot for overnight comparison', () => {
  it('saves a snapshot file to snapshotDir after successful run', async () => {
    const tmpDir = makeTmpDir();
    const leads = [makeLead({ fitScore: 80 })];
    const client = makeMockClient(leads);
    await generateMorningBriefing({ _client: client, _snapshotDir: tmpDir });
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('snapshot contains required fields', async () => {
    const tmpDir = makeTmpDir();
    const leads = [
      makeLead({ id: 'l1', fitScore: 85 }),
      makeLead({ id: 'l2', fitScore: 60 }),
    ];
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: tmpDir });
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8'),
    ) as BriefingSnapshot;
    expect(saved.date).toBeDefined();
    expect(typeof saved.totalLeads).toBe('number');
    expect(saved.byTier).toBeDefined();
    expect(typeof saved.campaignCount).toBe('number');
    expect(Array.isArray(saved.topLeadIds)).toBe(true);
  });

  it('snapshot totalLeads matches pipeline contacts total', async () => {
    const tmpDir = makeTmpDir();
    const leads = [makeLead({ fitScore: 80 }), makeLead({ fitScore: 60 })];
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: tmpDir });
    expect(briefing.snapshot.totalLeads).toBe(2);
  });

  it('snapshot topLeadIds contains IDs of top leads', async () => {
    const tmpDir = makeTmpDir();
    const leads = [makeLead({ id: 'hot-1', fitScore: 90 })];
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: tmpDir });
    expect(briefing.snapshot.topLeadIds).toContain('hot-1');
  });

  it('loads previous snapshot for overnight comparison on next run', async () => {
    const tmpDir = makeTmpDir();

    // Run 1: save a snapshot
    const leads1 = [makeLead({ id: 'l1', fitScore: 85 })];
    const client1 = makeMockClient(leads1);
    const briefing1 = await generateMorningBriefing({ _client: client1, _snapshotDir: tmpDir });
    expect(briefing1.overnightChanges.previousSnapshot).toBeNull();

    // Rename snapshot to yesterday so it's picked up as previous
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    fs.renameSync(path.join(tmpDir, files[0]), path.join(tmpDir, `${yesterdayStr}.json`));

    // Run 2: should load previous snapshot
    const leads2 = [makeLead({ id: 'l1', fitScore: 85 }), makeLead({ id: 'l2', fitScore: 70 })];
    const client2 = makeMockClient(leads2);
    const briefing2 = await generateMorningBriefing({ _client: client2, _snapshotDir: tmpDir });
    expect(briefing2.overnightChanges.previousSnapshot).not.toBeNull();
    expect(briefing2.overnightChanges.newLeads).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Schedule morning briefing via cron
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Schedule morning briefing via cron', () => {
  it('generateMorningBriefing is exported and callable', () => {
    expect(typeof generateMorningBriefing).toBe('function');
  });

  it('runs successfully with default cron expression', async () => {
    const leads = [makeLead({ fitScore: 75 })];
    const client = makeMockClient(leads);
    const briefing = await generateMorningBriefing({ _client: client, _snapshotDir: makeTmpDir() });
    expect(briefing).toBeDefined();
    expect(briefing.briefingText.length).toBeGreaterThan(0);
  });
});
