import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Stub rebuildMaster globally for this test file — none of the tests should
// hit the real GojiBerry API. Individual tests that want to verify rebuild
// behavior inject _rebuildMaster explicitly and assert on that mock.
vi.mock('../../src/contacts/rebuild-master.js', () => ({
  rebuildMaster: vi.fn().mockResolvedValue({ added: 0, updated: 0, unchanged: 0 }),
}));

import { runDailyLeadScan } from '../../src/automations/daily-lead-scan.js';
import { AuthError, ConfigError } from '../../src/api/errors.js';
import type { DiscoveryResult, EnrichmentResult, MessageGenerationResult } from '../../src/automations/types.js';
import type { Lead } from '../../src/api/types.js';

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
    location: 'San Francisco, CA',
    fitScore: 70,
    intentSignals: ['Raised Series A', 'Hiring SDRs'],
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeLeads(count: number, fitScoreBase = 70): Lead[] {
  return Array.from({ length: count }, (_, i) =>
    makeLead({
      id: `lead-${i + 1}`,
      firstName: 'Lead',
      lastName: `${i + 1}`,
      profileUrl: `https://linkedin.com/in/lead-${i + 1}`,
      fitScore: fitScoreBase + i,
    }),
  );
}

function discoveryResult(overrides: Partial<DiscoveryResult> = {}): DiscoveryResult {
  return {
    created: [],
    skipped: [],
    failed: [],
    limitExceeded: 0,
    ...overrides,
  };
}

function enrichmentResult(overrides: Partial<EnrichmentResult> = {}): EnrichmentResult {
  return {
    enriched: [],
    failed: [],
    skipped: [],
    remaining: 0,
    ...overrides,
  };
}

function messageResult(overrides: Partial<MessageGenerationResult> = {}): MessageGenerationResult {
  return {
    generated: [],
    failed: [],
    skipped: [],
    remaining: 0,
    ...overrides,
  };
}

function makeEnrichedLeads(leads: Lead[], fitScores: number[]) {
  return leads.map((lead, i) => ({
    lead,
    research: {
      fitScore: fitScores[i] ?? 70,
      intentSignals: ['Signal ' + (i + 1)],
      reasoning: 'Test reasoning',
    },
  }));
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daily-scan-test-'));
}

const ICP = 'B2B SaaS founders in fintech with 10-50 employees';

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Missing ICP description prevents scan
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Missing ICP description prevents scan', () => {
  beforeEach(() => {
    delete process.env.ICP_DESCRIPTION;
  });

  it('aborts before calling any APIs when ICP_DESCRIPTION is not set', async () => {
    const mockDiscover = vi.fn();
    const result = await runDailyLeadScan({ _discoverLeads: mockDiscover });
    expect(mockDiscover).not.toHaveBeenCalled();
    expect(result.discovery.created).toHaveLength(0);
    expect(result.enrichment).toBeNull();
  });

  it('outputs the required abort message when ICP_DESCRIPTION is missing', async () => {
    const result = await runDailyLeadScan({});
    expect(result.summaryText).toContain('Daily scan aborted — ICP_DESCRIPTION is required');
    expect(result.summaryText).toContain('Define your ideal customer to start scanning');
  });

  it('aborts when ICP_DESCRIPTION is empty string', async () => {
    process.env.ICP_DESCRIPTION = '';
    const mockDiscover = vi.fn();
    const result = await runDailyLeadScan({ _discoverLeads: mockDiscover });
    expect(mockDiscover).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: API authentication failure aborts immediately
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: API authentication failure aborts immediately', () => {
  it('aborts entire scan when discoverLeads throws AuthError', async () => {
    const mockDiscover = vi.fn().mockRejectedValue(new AuthError());
    const mockEnrich = vi.fn();
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: mockDiscover,
      _enrichLeads: mockEnrich,
    });
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(result.enrichment).toBeNull();
    expect(result.messageGeneration).toBeNull();
  });

  it('outputs the required auth abort message', async () => {
    const mockDiscover = vi.fn().mockRejectedValue(new AuthError());
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: mockDiscover,
    });
    expect(result.summaryText).toContain('Daily scan aborted — API authentication failed');
    expect(result.summaryText).toContain('Check your GOJIBERRY_API_KEY');
  });

  it('saves no partial results on auth abort', async () => {
    const mockDiscover = vi.fn().mockRejectedValue(new AuthError());
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: mockDiscover,
    });
    expect(result.discovery.created).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Discovery finds zero leads
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Discovery finds zero leads', () => {
  it('skips enrichment and message generation when zero leads created', async () => {
    const mockEnrich = vi.fn();
    const mockGenerate = vi.fn();
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: vi.fn().mockResolvedValue(discoveryResult({ created: [] })),
      _enrichLeads: mockEnrich,
      _generateMessages: mockGenerate,
    });
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(result.enrichment).toBeNull();
    expect(result.messageGeneration).toBeNull();
  });

  it('outputs the no-leads-found message', async () => {
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: vi.fn().mockResolvedValue(discoveryResult({ created: [] })),
    });
    expect(result.summaryText).toContain('No new leads found matching your ICP today');
  });

  it('suggests broadening ICP when no leads found', async () => {
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: vi.fn().mockResolvedValue(discoveryResult({ created: [] })),
    });
    expect(result.summaryText).toContain('consider broadening it');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Discovery fails (API error or web search failure)
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Discovery fails (API error or web search failure)', () => {
  it('catches discovery error and does not proceed to enrichment', async () => {
    const mockEnrich = vi.fn();
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: vi.fn().mockRejectedValue(new Error('Web search timed out')),
      _enrichLeads: mockEnrich,
    });
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(result.enrichment).toBeNull();
  });

  it('outputs the discovery failure message with error details', async () => {
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: vi.fn().mockRejectedValue(new Error('Web search timed out')),
    });
    expect(result.summaryText).toContain('Daily scan failed at discovery');
    expect(result.summaryText).toContain('Web search timed out');
  });

  it('saves no partial results when discovery fails', async () => {
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: vi.fn().mockRejectedValue(new Error('Network error')),
    });
    expect(result.discovery.created).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Run the full pipeline — discover, enrich, generate messages
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Run the full pipeline', () => {
  const leads = makeLeads(3, 60);
  const enriched = makeEnrichedLeads(leads, [70, 75, 80]);

  it('calls discoverLeads with icpDescription and leadLimit', async () => {
    const mockDiscover = vi.fn().mockResolvedValue(
      discoveryResult({ created: leads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
    );
    const mockEnrich = vi.fn().mockResolvedValue(enrichmentResult({ enriched }));
    const mockGenerate = vi.fn().mockResolvedValue(
      messageResult({ generated: [{ lead: leads[0], message: 'Hi Lead 1' }] })
    );

    await runDailyLeadScan({
      icpDescription: ICP,
      leadLimit: 5,
      _discoverLeads: mockDiscover,
      _enrichLeads: mockEnrich,
      _generateMessages: mockGenerate,
    });

    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ icpDescription: ICP, limit: 5 }),
    );
  });

  it('calls enrichLeads after discovery', async () => {
    const mockEnrich = vi.fn().mockResolvedValue(enrichmentResult({ enriched }));
    const mockGenerate = vi.fn().mockResolvedValue(messageResult());

    await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: leads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: mockEnrich,
      _generateMessages: mockGenerate,
    });

    expect(mockEnrich).toHaveBeenCalled();
  });

  it('calls generateMessages for leads above MIN_INTENT_SCORE', async () => {
    const mockGenerate = vi.fn().mockResolvedValue(
      messageResult({ generated: [{ lead: leads[0], message: 'Hi' }] })
    );

    await runDailyLeadScan({
      icpDescription: ICP,
      minIntentScore: 50,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: leads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(enrichmentResult({ enriched })),
      _generateMessages: mockGenerate,
    });

    expect(mockGenerate).toHaveBeenCalled();
  });

  it('summary includes pipeline counts', async () => {
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: leads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(enrichmentResult({ enriched })),
      _generateMessages: vi.fn().mockResolvedValue(
        messageResult({ generated: [{ lead: leads[0], message: 'Hi' }] })
      ),
    });

    expect(result.summaryText).toContain('3'); // discovered
    expect(result.discovery.created).toHaveLength(3);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Lead limit caps discovery
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Lead limit caps discovery', () => {
  it('passes limit: 5 to discoverLeads when DAILY_LEAD_SCAN_LIMIT is 5', async () => {
    const mockDiscover = vi.fn().mockResolvedValue(discoveryResult({ created: [] }));

    await runDailyLeadScan({
      icpDescription: ICP,
      leadLimit: 5,
      _discoverLeads: mockDiscover,
    });

    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
    );
  });

  it('reflects limitExceeded in summary text', async () => {
    const leads5 = makeLeads(5);
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      leadLimit: 5,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({
          created: leads5.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })),
          limitExceeded: 3,
        })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(enrichmentResult()),
      _generateMessages: vi.fn().mockResolvedValue(messageResult()),
    });

    expect(result.summaryText).toContain('limit');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Some leads already exist in GojiBerry (duplicates skipped)
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Duplicates skipped', () => {
  it('reports new and skipped leads in summary', async () => {
    const newLeads = makeLeads(2);
    const skippedLeads = makeLeads(3, 60).map(l => ({
      firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl
    }));
    const enriched = makeEnrichedLeads(newLeads, [70, 75]);

    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({
          created: newLeads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })),
          skipped: skippedLeads,
        })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(enrichmentResult({ enriched })),
      _generateMessages: vi.fn().mockResolvedValue(messageResult()),
    });

    expect(result.discovery.skipped).toHaveLength(3);
    expect(result.summaryText).toContain('skipped');
  });

  it('only new leads proceed to enrichment (enrichment called after discovery)', async () => {
    const mockEnrich = vi.fn().mockResolvedValue(enrichmentResult());

    await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({
          created: [{ firstName: 'A', lastName: 'B', profileUrl: 'https://linkedin.com/in/ab' }],
          skipped: [{ firstName: 'C', lastName: 'D', profileUrl: 'https://linkedin.com/in/cd' }],
        })
      ),
      _enrichLeads: mockEnrich,
      _generateMessages: vi.fn().mockResolvedValue(messageResult()),
    });

    expect(mockEnrich).toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Enrichment scores some leads below threshold
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Enrichment scores some leads below threshold', () => {
  it('runs message generation only for leads above threshold', async () => {
    const leads = makeLeads(10);
    // 6 above 50, 4 below
    const enriched = makeEnrichedLeads(leads.slice(0, 6), [60, 65, 70, 75, 80, 85]);
    const enrichedBelow = makeEnrichedLeads(leads.slice(6), [10, 20, 30, 40]);
    const allEnriched = [...enriched, ...enrichedBelow];

    const mockGenerate = vi.fn().mockResolvedValue(
      messageResult({ generated: leads.slice(0, 6).map(l => ({ lead: l, message: 'Hi' })) })
    );

    const result = await runDailyLeadScan({
      icpDescription: ICP,
      minIntentScore: 50,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: leads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(enrichmentResult({ enriched: allEnriched })),
      _generateMessages: mockGenerate,
    });

    expect(mockGenerate).toHaveBeenCalled();
    expect(result.aboveThreshold).toBe(6);
    expect(result.belowThreshold).toBe(4);
  });

  it('summary reports above/below threshold counts', async () => {
    const leads = makeLeads(10);
    const enriched = makeEnrichedLeads(leads.slice(0, 6), [60, 65, 70, 75, 80, 85]);
    const enrichedBelow = makeEnrichedLeads(leads.slice(6), [10, 20, 30, 40]);

    const result = await runDailyLeadScan({
      icpDescription: ICP,
      minIntentScore: 50,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: leads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(
        enrichmentResult({ enriched: [...enriched, ...enrichedBelow] })
      ),
      _generateMessages: vi.fn().mockResolvedValue(
        messageResult({ generated: leads.slice(0, 6).map(l => ({ lead: l, message: 'Hi' })) })
      ),
    });

    expect(result.summaryText).toContain('6');
    expect(result.summaryText).toContain('4');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: All leads score below intent threshold
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: All leads score below intent threshold', () => {
  const leads = makeLeads(5, 60);
  const enrichedBelow = makeEnrichedLeads(leads, [10, 20, 30, 40, 45]);

  it('skips message generation entirely when all leads below threshold', async () => {
    const mockGenerate = vi.fn();

    await runDailyLeadScan({
      icpDescription: ICP,
      minIntentScore: 50,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: leads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(enrichmentResult({ enriched: enrichedBelow })),
      _generateMessages: mockGenerate,
    });

    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('reports zero messages generated', async () => {
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      minIntentScore: 50,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: leads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(enrichmentResult({ enriched: enrichedBelow })),
    });

    expect(result.messageGeneration).toBeNull();
    expect(result.aboveThreshold).toBe(0);
    expect(result.belowThreshold).toBe(5);
  });

  it('suggests broadening ICP or lowering threshold', async () => {
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      minIntentScore: 50,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: leads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(enrichmentResult({ enriched: enrichedBelow })),
    });

    expect(result.summaryText).toContain('broadening your ICP');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Enrichment fails partway through a batch
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Enrichment fails partway through a batch', () => {
  const allLeads = makeLeads(8, 60);
  const enrichedLeads = makeEnrichedLeads(allLeads.slice(0, 5), [60, 65, 70, 75, 80]);
  const failedLeads = allLeads.slice(5).map((l, i) => ({
    lead: l,
    error: `Enrichment error ${i + 1}`,
  }));

  it('runs message generation for successfully enriched leads above threshold', async () => {
    const mockGenerate = vi.fn().mockResolvedValue(
      messageResult({ generated: allLeads.slice(0, 5).map(l => ({ lead: l, message: 'Hi' })) })
    );

    await runDailyLeadScan({
      icpDescription: ICP,
      minIntentScore: 50,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: allLeads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(
        enrichmentResult({ enriched: enrichedLeads, failed: failedLeads })
      ),
      _generateMessages: mockGenerate,
    });

    expect(mockGenerate).toHaveBeenCalled();
  });

  it('reports enrichment failures in summary', async () => {
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      minIntentScore: 50,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: allLeads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(
        enrichmentResult({ enriched: enrichedLeads, failed: failedLeads })
      ),
      _generateMessages: vi.fn().mockResolvedValue(messageResult()),
    });

    expect(result.summaryText).toContain('5 leads enriched');
    expect(result.summaryText).toContain('3 failed');
    expect(result.failures.filter(f => f.stage === 'enrichment')).toHaveLength(3);
  });

  it('lists failed leads in failures array', async () => {
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: allLeads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(
        enrichmentResult({ enriched: enrichedLeads, failed: failedLeads })
      ),
      _generateMessages: vi.fn().mockResolvedValue(messageResult()),
    });

    const enrichFailures = result.failures.filter(f => f.stage === 'enrichment');
    expect(enrichFailures[0].lead).toContain('Lead 6');
    expect(enrichFailures[0].error).toContain('Enrichment error 1');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Message generation fails for some leads
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Message generation fails for some leads', () => {
  const leads = makeLeads(6, 60);
  const enriched = makeEnrichedLeads(leads, [60, 65, 70, 75, 80, 85]);

  it('reports partial message generation failures', async () => {
    const successLeads = leads.slice(0, 4);
    const failedLeads = leads.slice(4).map((l, i) => ({
      lead: l,
      error: `Message gen error ${i + 1}`,
    }));

    const result = await runDailyLeadScan({
      icpDescription: ICP,
      minIntentScore: 50,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: leads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(enrichmentResult({ enriched })),
      _generateMessages: vi.fn().mockResolvedValue(
        messageResult({
          generated: successLeads.map(l => ({ lead: l, message: 'Hi' })),
          failed: failedLeads,
        })
      ),
    });

    expect(result.summaryText).toContain('4 messages generated');
    expect(result.summaryText).toContain('2 failed');
    expect(result.failures.filter(f => f.stage === 'messages')).toHaveLength(2);
  });

  it('still reports successfully generated messages', async () => {
    const successLeads = leads.slice(0, 4);

    const result = await runDailyLeadScan({
      icpDescription: ICP,
      minIntentScore: 50,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: leads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(enrichmentResult({ enriched })),
      _generateMessages: vi.fn().mockResolvedValue(
        messageResult({
          generated: successLeads.map(l => ({ lead: l, message: 'Hi' })),
          failed: leads.slice(4).map(l => ({ lead: l, error: 'Failed' })),
        })
      ),
    });

    expect(result.messageGeneration?.generated).toHaveLength(4);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Save scan results for reporting
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Save scan results for reporting', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves scan log to _scanLogDir/{date}.json', async () => {
    const leads = makeLeads(2);
    const enriched = makeEnrichedLeads(leads, [70, 80]);

    await runDailyLeadScan({
      icpDescription: ICP,
      _scanLogDir: tmpDir,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: leads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(enrichmentResult({ enriched })),
      _generateMessages: vi.fn().mockResolvedValue(
        messageResult({ generated: [{ lead: leads[0], message: 'Hi' }] })
      ),
    });

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('log includes required fields: date, leads discovered/enriched/messaged, failures, duration', async () => {
    const leads = makeLeads(2);
    const enriched = makeEnrichedLeads(leads, [70, 80]);

    await runDailyLeadScan({
      icpDescription: ICP,
      _scanLogDir: tmpDir,
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: leads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(enrichmentResult({ enriched })),
      _generateMessages: vi.fn().mockResolvedValue(
        messageResult({ generated: [{ lead: leads[0], message: 'Hi' }] })
      ),
    });

    const files = fs.readdirSync(tmpDir);
    const logContent = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8'));

    expect(logContent).toHaveProperty('date');
    expect(logContent).toHaveProperty('discovery');
    expect(logContent).toHaveProperty('enrichment');
    expect(logContent).toHaveProperty('messageGeneration');
    expect(logContent).toHaveProperty('failures');
    expect(logContent).toHaveProperty('durationMs');
    expect(logContent).not.toHaveProperty('summaryText'); // excluded from machine-readable log
  });

  it('log excludes summaryText to stay machine-readable', async () => {
    await runDailyLeadScan({
      icpDescription: ICP,
      _scanLogDir: tmpDir,
      _discoverLeads: vi.fn().mockResolvedValue(discoveryResult({ created: [] })),
    });

    const files = fs.readdirSync(tmpDir);
    const logContent = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8'));
    expect(logContent).not.toHaveProperty('summaryText');
  });

  it('saves log even when zero leads found', async () => {
    await runDailyLeadScan({
      icpDescription: ICP,
      _scanLogDir: tmpDir,
      _discoverLeads: vi.fn().mockResolvedValue(discoveryResult({ created: [] })),
    });

    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: DailyScanResult structure
// ──────────────────────────────────────────────────────────────────────────────

describe('DailyScanResult structure', () => {
  it('includes date in YYYY-MM-DD format', async () => {
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: vi.fn().mockResolvedValue(discoveryResult({ created: [] })),
    });
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('includes durationMs', async () => {
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: vi.fn().mockResolvedValue(discoveryResult({ created: [] })),
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('includes nextAction string', async () => {
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: vi.fn().mockResolvedValue(discoveryResult({ created: [] })),
    });
    expect(typeof result.nextAction).toBe('string');
    expect(result.nextAction.length).toBeGreaterThan(0);
  });

  it('includes next scan reference in summary', async () => {
    const result = await runDailyLeadScan({
      icpDescription: ICP,
      _discoverLeads: vi.fn().mockResolvedValue(discoveryResult({ created: [] })),
    });
    expect(result.summaryText).toContain('Next scan');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Default env config
// ──────────────────────────────────────────────────────────────────────────────

describe('Default env config', () => {
  beforeEach(() => {
    process.env.ICP_DESCRIPTION = ICP;
    process.env.DAILY_LEAD_SCAN_LIMIT = '7';
    process.env.MIN_INTENT_SCORE = '60';
  });

  afterEach(() => {
    delete process.env.ICP_DESCRIPTION;
    delete process.env.DAILY_LEAD_SCAN_LIMIT;
    delete process.env.MIN_INTENT_SCORE;
  });

  it('reads DAILY_LEAD_SCAN_LIMIT from env when not in options', async () => {
    const mockDiscover = vi.fn().mockResolvedValue(discoveryResult({ created: [] }));

    await runDailyLeadScan({ _discoverLeads: mockDiscover });

    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 7 }),
    );
  });

  it('reads MIN_INTENT_SCORE from env', async () => {
    const leads = makeLeads(3);
    // All above new threshold of 60
    const enriched = makeEnrichedLeads(leads, [65, 70, 75]);
    const mockGenerate = vi.fn().mockResolvedValue(messageResult());

    await runDailyLeadScan({
      _discoverLeads: vi.fn().mockResolvedValue(
        discoveryResult({ created: leads.map(l => ({ firstName: l.firstName, lastName: l.lastName, profileUrl: l.profileUrl })) })
      ),
      _enrichLeads: vi.fn().mockResolvedValue(enrichmentResult({ enriched })),
      _generateMessages: mockGenerate,
    });

    // All above 60 threshold → generate should be called
    expect(mockGenerate).toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Refresh master before discovery (dedup accuracy)
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Refresh master before discovery', () => {
  beforeEach(() => {
    process.env.ICP_DESCRIPTION = ICP;
  });

  afterEach(() => {
    delete process.env.ICP_DESCRIPTION;
  });

  it('calls rebuildMaster before discoverLeads', async () => {
    const callOrder: string[] = [];
    const mockRebuild = vi.fn().mockImplementation(async () => {
      callOrder.push('rebuild');
      return { added: 0, updated: 0, unchanged: 0 };
    });
    const mockDiscover = vi.fn().mockImplementation(async () => {
      callOrder.push('discover');
      return discoveryResult();
    });

    await runDailyLeadScan({
      _rebuildMaster: mockRebuild,
      _discoverLeads: mockDiscover,
      _scanLogDir: makeTempDir(),
    });

    expect(callOrder).toEqual(['rebuild', 'discover']);
  });

  it('passes masterFilePath to discoverLeads so it dedups against the same file', async () => {
    const mockRebuild = vi.fn().mockResolvedValue({ added: 0, updated: 0, unchanged: 0 });
    const mockDiscover = vi.fn().mockResolvedValue(discoveryResult());
    const customMaster = '/tmp/custom-master.jsonl';

    await runDailyLeadScan({
      _rebuildMaster: mockRebuild,
      _discoverLeads: mockDiscover,
      _masterFilePath: customMaster,
      _scanLogDir: makeTempDir(),
    });

    expect(mockDiscover).toHaveBeenCalledWith(
      expect.objectContaining({ masterFilePath: customMaster }),
    );
    expect(mockRebuild).toHaveBeenCalledWith(
      expect.objectContaining({ masterFilePath: customMaster }),
    );
  });

  it('passes the resolved scanLogDir (including test overrides) to rebuildMaster', async () => {
    const mockRebuild = vi.fn().mockResolvedValue({ added: 0, updated: 0, unchanged: 0 });
    const mockDiscover = vi.fn().mockResolvedValue(discoveryResult());
    const tmpScanDir = makeTempDir();

    await runDailyLeadScan({
      _rebuildMaster: mockRebuild,
      _discoverLeads: mockDiscover,
      _scanLogDir: tmpScanDir,
    });

    // Must honor _scanLogDir — if rebuildMaster uses the default instead of the
    // test-provided path, it would read from the real data/scan-logs/ in CI.
    expect(mockRebuild).toHaveBeenCalledWith(
      expect.objectContaining({ scanLogsDir: tmpScanDir }),
    );
  });

  it('aborts with AUTH_ABORT message when rebuildMaster throws AuthError', async () => {
    const mockRebuild = vi.fn().mockRejectedValue(new AuthError());
    const mockDiscover = vi.fn();

    const result = await runDailyLeadScan({
      _rebuildMaster: mockRebuild,
      _discoverLeads: mockDiscover,
      _scanLogDir: makeTempDir(),
    });

    expect(result.nextAction).toMatch(/API authentication failed/i);
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it('continues scan when rebuildMaster throws a non-auth error (warns, proceeds)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mockRebuild = vi.fn().mockRejectedValue(new Error('network timeout'));
    const mockDiscover = vi.fn().mockResolvedValue(discoveryResult());

    await runDailyLeadScan({
      _rebuildMaster: mockRebuild,
      _discoverLeads: mockDiscover,
      _scanLogDir: makeTempDir(),
    });

    // Discovery still runs; warning is emitted.
    expect(mockDiscover).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/master rebuild failed.+continuing.+network timeout/i),
    );
    warnSpy.mockRestore();
  });
});
