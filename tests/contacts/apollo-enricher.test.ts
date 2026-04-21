import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  enrichContacts,
  correlateApolloResponse,
  normalizeLinkedInUrl,
} from '../../src/contacts/apollo-enricher.js';
import type { EnrichmentPlan } from '../../src/contacts/apollo-enricher.js';
import type { MasterContact, ApolloMatchResult, ApolloClient } from '../../src/contacts/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

function makeMaster(overrides: Partial<MasterContact> = {}): MasterContact {
  return {
    id: 1001,
    firstName: 'Jane',
    lastName: 'Doe',
    fullName: 'Jane Doe',
    profileUrl: 'https://linkedin.com/in/jane-doe',
    company: 'Acme',
    jobTitle: 'VP Sales',
    location: 'Austin, TX',
    icpScore: 82,
    fit: 'qualified',
    intentSignals: [],
    intentType: null,
    reasoning: null,
    personalizedMessages: [],
    email: null,
    phone: null,
    apolloPersonId: null,
    apolloEnrichedAt: null,
    apolloMatchConfidence: null,
    gojiberryState: {
      listId: null,
      campaignStatus: [],
      readyForCampaign: false,
      bounced: false,
      unsubscribed: false,
      updatedAt: null,
    },
    sources: [],
    masterUpdatedAt: '2026-04-20T00:00:00Z',
    ...overrides,
  };
}

function writeMasterFile(masterFile: string, contacts: MasterContact[]): void {
  fs.writeFileSync(masterFile, contacts.map((c) => JSON.stringify(c)).join('\n') + (contacts.length ? '\n' : ''));
}

function readMasterFile(masterFile: string): MasterContact[] {
  if (!fs.existsSync(masterFile)) return [];
  return fs
    .readFileSync(masterFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as MasterContact);
}

function mockApollo(impl: Partial<ApolloClient> = {}): ApolloClient {
  return {
    peopleMatch: impl.peopleMatch ?? vi.fn().mockResolvedValue({ match: true, email: null, personId: null } as ApolloMatchResult),
    peopleBulkMatch: impl.peopleBulkMatch ?? vi.fn().mockResolvedValue([]),
  };
}

let tmpDir: string;
let masterFile: string;
let logFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-enricher-'));
  masterFile = path.join(tmpDir, 'contacts.jsonl');
  logFile = path.join(tmpDir, 'apollo-enrichment-log.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Dry run is the default — no credits spent without --apply
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Dry run is the default', () => {
  it('does not call Apollo when apply is false', async () => {
    writeMasterFile(masterFile, [makeMaster({ id: 1 }), makeMaster({ id: 2 })]);
    const apollo = mockApollo();
    const result = await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: false,
      runBudget: 50,
      totalBudget: 500,
    });
    expect(apollo.peopleMatch).not.toHaveBeenCalled();
    expect(apollo.peopleBulkMatch).not.toHaveBeenCalled();
    expect(result.creditsUsed).toBe(0);
    expect(result.enriched).toBe(0);
  });

  it('reports eligible count and projected credits in dry-run result', async () => {
    writeMasterFile(masterFile, [makeMaster({ id: 1 }), makeMaster({ id: 2 }), makeMaster({ id: 3 })]);
    const apollo = mockApollo();
    const result = await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: false,
      runBudget: 50,
      totalBudget: 500,
    });
    expect(result.eligible).toBe(3);
    expect(result.projectedCredits).toBe(3);
  });

  it('does not modify master file in dry-run mode', async () => {
    writeMasterFile(masterFile, [makeMaster({ id: 1 })]);
    const before = fs.readFileSync(masterFile, 'utf8');
    await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: mockApollo(),
      apply: false,
      runBudget: 50,
      totalBudget: 500,
    });
    const after = fs.readFileSync(masterFile, 'utf8');
    expect(after).toBe(before);
  });

  it('does not write to enrichment log in dry-run mode', async () => {
    writeMasterFile(masterFile, [makeMaster({ id: 1 })]);
    await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: mockApollo(),
      apply: false,
      runBudget: 50,
      totalBudget: 500,
    });
    expect(fs.existsSync(logFile)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Budget cap enforced before any Apollo call
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Per-run budget cap enforced', () => {
  it('caps enrichments at APOLLO_RUN_BUDGET', async () => {
    const contacts = Array.from({ length: 150 }, (_, i) => makeMaster({ id: 100 + i, icpScore: 90 - i }));
    writeMasterFile(masterFile, contacts);
    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockImplementation(async (inputs: { linkedinUrl: string }[]) =>
        inputs.map((inp) => ({ match: true, email: `${inp.linkedinUrl}@test.com`, personId: 'p', linkedinUrl: inp.linkedinUrl })),
      ),
    });
    const result = await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
    });
    expect(result.enriched).toBe(50);
    expect(result.creditsUsed).toBe(50);
  });

  it('enriches highest ICP score first', async () => {
    const contacts = [
      makeMaster({ id: 1, icpScore: 50, profileUrl: 'https://linkedin.com/in/low' }),
      makeMaster({ id: 2, icpScore: 95, profileUrl: 'https://linkedin.com/in/high' }),
      makeMaster({ id: 3, icpScore: 75, profileUrl: 'https://linkedin.com/in/mid' }),
    ];
    writeMasterFile(masterFile, contacts);
    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockImplementation(async (inputs: { linkedinUrl: string }[]) =>
        inputs.map((inp) => ({ match: true, email: `${inp.linkedinUrl.split('/').pop()}@x.com`, personId: 'p', linkedinUrl: inp.linkedinUrl })),
      ),
    });
    await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 2,
      totalBudget: 500,
    });
    const enriched = readMasterFile(masterFile);
    const withEmail = enriched.filter((c) => c.email !== null).map((c) => c.id);
    expect(withEmail).toEqual(expect.arrayContaining([2, 3]));
    expect(withEmail).not.toContain(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Total budget cap enforced across runs
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Total budget cap enforced across runs', () => {
  it('subtracts already-consumed credits from log file', async () => {
    writeMasterFile(masterFile, Array.from({ length: 30 }, (_, i) => makeMaster({ id: 100 + i, icpScore: 80 - i })));
    // Seed log with 480 credits consumed
    const seedLogs = Array.from({ length: 480 }, (_, i) => ({
      timestamp: '2026-04-19T00:00:00Z',
      runId: 'prev',
      contactId: 9000 + i,
      linkedinUrl: `https://linkedin.com/in/prev-${i}`,
      credits: 1,
      outcome: 'success',
    }));
    fs.writeFileSync(logFile, seedLogs.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockImplementation(async (inputs: { linkedinUrl: string }[]) =>
        inputs.map((inp) => ({ match: true, email: 'x@y.com', personId: 'p', linkedinUrl: inp.linkedinUrl })),
      ),
    });
    const result = await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
    });
    expect(result.creditsUsed).toBe(20); // 500 - 480
  });

  it('exits with warning when total budget already exhausted', async () => {
    writeMasterFile(masterFile, [makeMaster({ id: 1 })]);
    const seedLogs = Array.from({ length: 500 }, (_, i) => ({
      timestamp: '2026-04-19T00:00:00Z',
      runId: 'prev',
      contactId: 9000 + i,
      linkedinUrl: `https://linkedin.com/in/prev-${i}`,
      credits: 1,
      outcome: 'success',
    }));
    fs.writeFileSync(logFile, seedLogs.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const apollo = mockApollo();
    const result = await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
    });
    expect(result.creditsUsed).toBe(0);
    expect(result.warnings).toContain('total-budget-exhausted');
    expect(apollo.peopleBulkMatch).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Ghost call prevention gates
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Ghost call prevention', () => {
  it('skips contacts missing profileUrl', async () => {
    writeMasterFile(masterFile, [
      makeMaster({ id: 1, profileUrl: '' }),
      makeMaster({ id: 2, profileUrl: 'https://linkedin.com/in/ok' }),
    ]);
    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockResolvedValue([{ match: true, email: 'a@b.com', personId: 'p', linkedinUrl: 'https://linkedin.com/in/ok' }]),
    });
    const result = await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
    });
    expect(result.skippedByGate['no-profile-url']).toBe(1);
    expect(result.enriched).toBe(1);
  });

  it('skips contacts missing name or company', async () => {
    writeMasterFile(masterFile, [
      makeMaster({ id: 1, firstName: '' }),
      makeMaster({ id: 2, company: null }),
      makeMaster({ id: 3 }),
    ]);
    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockResolvedValue([{ match: true, email: 'a@b.com', personId: 'p', linkedinUrl: 'https://linkedin.com/in/jane-doe' }]),
    });
    const result = await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
    });
    expect(result.skippedByGate['missing-name-or-company']).toBe(2);
    expect(result.enriched).toBe(1);
  });

  it('skips contacts already enriched (apolloEnrichedAt set)', async () => {
    writeMasterFile(masterFile, [
      makeMaster({ id: 1, apolloEnrichedAt: '2026-04-19T00:00:00Z' }),
      makeMaster({ id: 2, apolloEnrichedAt: null }),
    ]);
    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockResolvedValue([{ match: true, email: 'a@b.com', personId: 'p', linkedinUrl: 'https://linkedin.com/in/jane-doe' }]),
    });
    const result = await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
    });
    expect(result.skippedByGate['already-enriched']).toBe(1);
    expect(result.enriched).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Apollo outcomes (success, no-email, no-match, error)
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Apollo match outcomes', () => {
  it('writes email, personId, confidence, and apolloEnrichedAt on success', async () => {
    writeMasterFile(masterFile, [makeMaster({ id: 1001, profileUrl: 'https://linkedin.com/in/adam' })]);
    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockResolvedValue([
        { match: true, email: 'adam@hollandroofing.com', personId: 'apollo_abc', confidence: 0.92, linkedinUrl: 'https://linkedin.com/in/adam' },
      ]),
    });
    await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
    });
    const [updated] = readMasterFile(masterFile);
    expect(updated.email).toBe('adam@hollandroofing.com');
    expect(updated.apolloPersonId).toBe('apollo_abc');
    expect(updated.apolloMatchConfidence).toBe(0.92);
    expect(updated.apolloEnrichedAt).toBeTruthy();
  });

  it('marks contact enriched even when Apollo returns no email (idempotency)', async () => {
    writeMasterFile(masterFile, [makeMaster({ id: 1001, profileUrl: 'https://linkedin.com/in/jane' })]);
    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockResolvedValue([
        { match: true, email: null, personId: 'apollo_xyz', linkedinUrl: 'https://linkedin.com/in/jane' },
      ]),
    });
    await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
    });
    const [updated] = readMasterFile(masterFile);
    expect(updated.email).toBeNull();
    expect(updated.apolloPersonId).toBe('apollo_xyz');
    expect(updated.apolloEnrichedAt).toBeTruthy();
  });

  it('marks contact enriched on no-match (prevents ghost loops)', async () => {
    writeMasterFile(masterFile, [makeMaster({ id: 1001, profileUrl: 'https://linkedin.com/in/jane' })]);
    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockResolvedValue([{ match: false, linkedinUrl: 'https://linkedin.com/in/jane' }]),
    });
    await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
    });
    const [updated] = readMasterFile(masterFile);
    expect(updated.email).toBeNull();
    expect(updated.apolloPersonId).toBeNull();
    expect(updated.apolloEnrichedAt).toBeTruthy();
  });

  it('does NOT mark contact enriched on Apollo error (retryable)', async () => {
    writeMasterFile(masterFile, [
      makeMaster({ id: 1001, profileUrl: 'https://linkedin.com/in/jane' }),
      makeMaster({ id: 1002, profileUrl: 'https://linkedin.com/in/bob' }),
    ]);
    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockRejectedValueOnce(new Error('network timeout')).mockResolvedValueOnce([
        { match: true, email: 'bob@c.com', personId: 'p', linkedinUrl: 'https://linkedin.com/in/bob' },
      ]),
    });
    const result = await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
      batchSize: 1, // force one-per-batch so error only hits one contact
    });
    const contacts = readMasterFile(masterFile);
    const jane = contacts.find((c) => c.id === 1001)!;
    const bob = contacts.find((c) => c.id === 1002)!;
    expect(jane.apolloEnrichedAt).toBeNull();
    expect(bob.apolloEnrichedAt).toBeTruthy();
    expect(result.outcomes.error).toBe(1);
    expect(result.outcomes.success).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Bulk match used for batches of 10+
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Bulk matching', () => {
  it('calls peopleBulkMatch in batches of 10', async () => {
    writeMasterFile(
      masterFile,
      Array.from({ length: 25 }, (_, i) =>
        makeMaster({
          id: 100 + i,
          firstName: `P${i}`,
          profileUrl: `https://linkedin.com/in/p${i}`,
        }),
      ),
    );
    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockImplementation(async (inputs: { linkedinUrl: string }[]) =>
        inputs.map((inp) => ({ match: true, email: 'e@e.com', personId: 'p', linkedinUrl: inp.linkedinUrl })),
      ),
    });
    await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
    });
    // 25 eligible, batch of 10 → 3 calls (10, 10, 5)
    expect((apollo.peopleBulkMatch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    const batchSizes = (apollo.peopleBulkMatch as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].length);
    expect(batchSizes).toEqual([10, 10, 5]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: --limit caps number considered
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: --limit flag', () => {
  it('only enriches up to limit', async () => {
    writeMasterFile(masterFile, Array.from({ length: 20 }, (_, i) => makeMaster({ id: 100 + i, icpScore: 80 })));
    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockImplementation(async (inputs: { linkedinUrl: string }[]) =>
        inputs.map((inp) => ({ match: true, email: 'e@e.com', personId: 'p', linkedinUrl: inp.linkedinUrl })),
      ),
    });
    const result = await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
      limit: 3,
    });
    expect(result.enriched).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Enrichment log is written
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Enrichment log', () => {
  it('appends one log entry per Apollo call outcome', async () => {
    writeMasterFile(masterFile, [
      makeMaster({ id: 1, profileUrl: 'https://linkedin.com/in/a' }),
      makeMaster({ id: 2, profileUrl: 'https://linkedin.com/in/b' }),
    ]);
    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockResolvedValue([
        { match: true, email: 'a@x.com', personId: 'pa', linkedinUrl: 'https://linkedin.com/in/a' },
        { match: false, linkedinUrl: 'https://linkedin.com/in/b' },
      ]),
    });
    await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
    });
    const logLines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    expect(logLines).toHaveLength(2);
    const entries = logLines.map((l) => JSON.parse(l));
    expect(entries.map((e) => e.outcome).sort()).toEqual(['no-match', 'success']);
    expect(entries.every((e) => e.runId && e.timestamp && typeof e.credits === 'number')).toBe(true);
  });

  it('log entries include batchSize when bulk-matched', async () => {
    writeMasterFile(masterFile, [makeMaster({ id: 1, profileUrl: 'https://linkedin.com/in/a' })]);
    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockResolvedValue([{ match: true, email: 'a@x.com', personId: 'p', linkedinUrl: 'https://linkedin.com/in/a' }]),
    });
    await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
    });
    const [entry] = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entry.batchSize).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: URL normalization and correlation with raw Apollo response
// ──────────────────────────────────────────────────────────────────────────────

describe('normalizeLinkedInUrl', () => {
  it('strips trailing slash', () => {
    expect(normalizeLinkedInUrl('https://www.linkedin.com/in/foo/')).toBe('http://linkedin.com/in/foo');
  });

  it('converts https to http', () => {
    expect(normalizeLinkedInUrl('https://linkedin.com/in/foo')).toBe('http://linkedin.com/in/foo');
  });

  it('strips www subdomain', () => {
    expect(normalizeLinkedInUrl('http://www.linkedin.com/in/foo')).toBe('http://linkedin.com/in/foo');
  });

  it('strips non-www country subdomains', () => {
    expect(normalizeLinkedInUrl('https://uk.linkedin.com/in/foo')).toBe('http://linkedin.com/in/foo');
    expect(normalizeLinkedInUrl('https://de.linkedin.com/in/foo')).toBe('http://linkedin.com/in/foo');
  });

  it('strips query strings', () => {
    expect(normalizeLinkedInUrl('https://www.linkedin.com/in/foo?trk=abc&source=share')).toBe('http://linkedin.com/in/foo');
  });

  it('strips URL fragments', () => {
    expect(normalizeLinkedInUrl('https://linkedin.com/in/foo#about')).toBe('http://linkedin.com/in/foo');
  });

  it('strips query AND fragment AND trailing slash in one pass', () => {
    expect(normalizeLinkedInUrl('HTTPS://WWW.LinkedIn.com/in/foo/?x=1#bar')).toBe('http://linkedin.com/in/foo');
  });

  it('is idempotent', () => {
    const once = normalizeLinkedInUrl('https://www.linkedin.com/in/foo/');
    expect(normalizeLinkedInUrl(once)).toBe(once);
  });

  it('handles the exact real Apollo normalization we observed', () => {
    // Input we sent:
    const sent = 'https://www.linkedin.com/in/luke-gaeta-636244375/';
    // Output Apollo returned:
    const got = 'http://www.linkedin.com/in/luke-gaeta-636244375';
    expect(normalizeLinkedInUrl(sent)).toBe(normalizeLinkedInUrl(got));
  });

  it('returns empty string for empty input', () => {
    expect(normalizeLinkedInUrl('')).toBe('');
  });

  it('returns the trimmed lowercased input when no linkedin.com found', () => {
    expect(normalizeLinkedInUrl('https://example.com/foo')).toBe('https://example.com/foo');
  });
});

describe('correlateApolloResponse', () => {
  function makePlan(details: Array<{ id: string; linkedin_url: string }>): EnrichmentPlan {
    return {
      runId: 'test-run',
      batches: [{ batchIndex: 0, details: details.map((d) => ({ ...d, first_name: 'x', last_name: 'y', organization_name: 'z' })) }],
      eligible: details.length,
      projectedCredits: details.length,
      creditsAlreadyUsed: 0,
      budgetRemaining: 100,
      skippedByGate: {},
      warnings: [],
      masterFilePath: '/tmp/x',
      logFilePath: '/tmp/y',
    };
  }

  it('correlates by normalized URL even when Apollo changes casing/protocol/slash', () => {
    const plan = makePlan([
      { id: '1001', linkedin_url: 'https://www.linkedin.com/in/luke/' },
      { id: '1002', linkedin_url: 'https://www.linkedin.com/in/derek' },
    ]);
    const apolloResponse = {
      matches: [
        { id: 'apollo_luke', linkedin_url: 'http://www.linkedin.com/in/luke', email: 'luke@x.com', email_status: 'verified' },
        { id: 'apollo_derek', linkedin_url: 'http://linkedin.com/in/derek', email: 'derek@y.com', email_status: 'verified' },
      ],
    };
    const results = correlateApolloResponse(plan, apolloResponse);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.contactId === 1001)?.email).toBe('luke@x.com');
    expect(results.find((r) => r.contactId === 1002)?.email).toBe('derek@y.com');
  });

  it('returns match=false for plan contacts missing from Apollo response', () => {
    const plan = makePlan([
      { id: '1001', linkedin_url: 'https://linkedin.com/in/found' },
      { id: '1002', linkedin_url: 'https://linkedin.com/in/missing' },
    ]);
    const apolloResponse = {
      matches: [{ id: 'p', linkedin_url: 'http://linkedin.com/in/found', email: 'f@x.com', email_status: 'verified' }],
    };
    const results = correlateApolloResponse(plan, apolloResponse);
    const missing = results.find((r) => r.contactId === 1002);
    expect(missing?.match).toBe(false);
    expect(missing?.email).toBeUndefined();
  });

  it('maps email_status=verified to confidence=1.0', () => {
    const plan = makePlan([{ id: '1', linkedin_url: 'https://linkedin.com/in/a' }]);
    const apolloResponse = {
      matches: [{ id: 'p', linkedin_url: 'http://linkedin.com/in/a', email: 'a@x.com', email_status: 'verified' }],
    };
    const [r] = correlateApolloResponse(plan, apolloResponse);
    expect(r.confidence).toBe(1.0);
  });

  it('leaves confidence undefined when email_status is not verified', () => {
    const plan = makePlan([{ id: '1', linkedin_url: 'https://linkedin.com/in/a' }]);
    const apolloResponse = {
      matches: [{ id: 'p', linkedin_url: 'http://linkedin.com/in/a', email: 'a@x.com', email_status: 'guessed' }],
    };
    const [r] = correlateApolloResponse(plan, apolloResponse);
    expect(r.confidence).toBeUndefined();
  });

  it('handles empty Apollo response (all plan contacts → no-match)', () => {
    const plan = makePlan([
      { id: '1', linkedin_url: 'https://linkedin.com/in/a' },
      { id: '2', linkedin_url: 'https://linkedin.com/in/b' },
    ]);
    const results = correlateApolloResponse(plan, {});
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.match === false)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: listId filter — target a specific GojiBerry list
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: list-id filter', () => {
  it('only considers contacts in the specified list when listId is provided', async () => {
    writeMasterFile(masterFile, [
      makeMaster({
        id: 1,
        profileUrl: 'https://linkedin.com/in/in-list',
        gojiberryState: {
          listId: 14507,
          campaignStatus: [],
          readyForCampaign: false,
          bounced: false,
          unsubscribed: false,
          updatedAt: null,
        },
      }),
      makeMaster({
        id: 2,
        profileUrl: 'https://linkedin.com/in/other-list',
        gojiberryState: {
          listId: 99,
          campaignStatus: [],
          readyForCampaign: false,
          bounced: false,
          unsubscribed: false,
          updatedAt: null,
        },
      }),
      makeMaster({
        id: 3,
        profileUrl: 'https://linkedin.com/in/no-list',
        gojiberryState: {
          listId: null,
          campaignStatus: [],
          readyForCampaign: false,
          bounced: false,
          unsubscribed: false,
          updatedAt: null,
        },
      }),
    ]);

    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockImplementation(async (inputs: { linkedinUrl: string }[]) =>
        inputs.map((inp) => ({ match: true, email: 'e@e.com', personId: 'p', linkedinUrl: inp.linkedinUrl })),
      ),
    });
    const result = await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
      listId: 14507,
    });

    // Only id=1 (listId 14507) is enriched. id=2 and id=3 are gate-filtered.
    expect(result.enriched).toBe(1);
    expect(result.skippedByGate['not-in-list']).toBe(2);
  });

  it('considers all eligible contacts when listId is omitted', async () => {
    writeMasterFile(masterFile, [
      makeMaster({
        id: 1,
        gojiberryState: {
          listId: 14507,
          campaignStatus: [],
          readyForCampaign: false,
          bounced: false,
          unsubscribed: false,
          updatedAt: null,
        },
      }),
      makeMaster({ id: 2, profileUrl: 'https://linkedin.com/in/id2' }),
    ]);

    const apollo = mockApollo({
      peopleBulkMatch: vi.fn().mockImplementation(async (inputs: { linkedinUrl: string }[]) =>
        inputs.map((inp) => ({ match: true, email: 'e@e.com', personId: 'p', linkedinUrl: inp.linkedinUrl })),
      ),
    });
    const result = await enrichContacts({
      masterFilePath: masterFile,
      logFilePath: logFile,
      _apollo: apollo,
      apply: true,
      runBudget: 50,
      totalBudget: 500,
    });

    expect(result.enriched).toBe(2);
  });
});
