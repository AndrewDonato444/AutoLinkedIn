import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { rebuildMaster, parseProfileBaseline } from '../../src/contacts/rebuild-master.js';
import type { Lead, PaginatedLeads } from '../../src/api/types.js';
import type { MasterContact } from '../../src/contacts/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────────

function makeGbLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: '1001',
    firstName: 'Jane',
    lastName: 'Doe',
    profileUrl: 'https://linkedin.com/in/jane-doe',
    company: 'Acme Corp',
    jobTitle: 'VP Sales',
    location: 'Austin, TX',
    profileBaseline:
      'ICP Score: 82/100\nReasoning: Growing team with aggressive hiring\nSignals: Hiring 3 SDRs, Series B\n',
    fit: 'qualified',
    ...overrides,
  };
}

function paginated(leads: Lead[]): PaginatedLeads {
  return { leads, total: leads.length, page: 1, pageSize: 100 };
}

function mockClient(pages: PaginatedLeads[]) {
  const fn = vi.fn();
  pages.forEach((p) => fn.mockResolvedValueOnce(p));
  fn.mockResolvedValue({ leads: [], total: pages.reduce((a, p) => a + p.leads.length, 0), page: 99, pageSize: 100 });
  return { searchLeads: fn };
}

let tmpDir: string;
let scanLogsDir: string;
let masterFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-master-'));
  scanLogsDir = path.join(tmpDir, 'scan-logs');
  masterFile = path.join(tmpDir, 'contacts.jsonl');
  fs.mkdirSync(scanLogsDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeScanLog(filename: string, body: Record<string, unknown>): void {
  fs.writeFileSync(path.join(scanLogsDir, filename), JSON.stringify(body));
}

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Initial rebuild populates master from GojiBerry and scan-logs
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Initial rebuild populates master from GojiBerry and scan-logs', () => {
  it('fetches all contacts from GojiBerry via paginated searchLeads', async () => {
    const client = mockClient([paginated([makeGbLead({ id: '1' }), makeGbLead({ id: '2' })])]);
    await rebuildMaster({ _client: client, scanLogsDir, masterFilePath: masterFile });
    expect(client.searchLeads).toHaveBeenCalled();
  });

  it('writes master with one line per unique contact', async () => {
    const client = mockClient([paginated([makeGbLead({ id: '1' }), makeGbLead({ id: '2' })])]);
    await rebuildMaster({ _client: client, scanLogsDir, masterFilePath: masterFile });
    const content = fs.readFileSync(masterFile, 'utf8');
    expect(content.trim().split('\n')).toHaveLength(2);
  });

  it('includes sources entry for scan-log files that referenced the contact', async () => {
    const client = mockClient([paginated([makeGbLead({ id: '1001' })])]);
    writeScanLog('scan-2026-04-16.json', {
      scanDate: '2026-04-16',
      contacts: [{ gojiberry_id: 1001, firstName: 'Jane', lastName: 'Doe', icpScore: 82, fit: 'qualified' }],
    });
    await rebuildMaster({ _client: client, scanLogsDir, masterFilePath: masterFile });
    const line = fs.readFileSync(masterFile, 'utf8').trim();
    const contact: MasterContact = JSON.parse(line);
    const refs = contact.sources.map((s) => s.ref);
    expect(refs).toContain('scan-2026-04-16.json');
    expect(refs).toContain('api');
  });

  it('handles scan log schema with newContacts + existingContacts', async () => {
    const client = mockClient([paginated([makeGbLead({ id: '1001' }), makeGbLead({ id: '1002' })])]);
    writeScanLog('scan-2026-04-13.json', {
      scanDate: '2026-04-13',
      newContacts: [{ id: 1001, name: 'Jane Doe', score: 82, fit: 'qualified', signals: 'Hiring SDRs' }],
      existingContacts: [{ id: 1002, name: 'Bob Smith', note: 'already existed' }],
    });
    await rebuildMaster({ _client: client, scanLogsDir, masterFilePath: masterFile });
    const lines = fs.readFileSync(masterFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Scan-log reasoning overrides GojiBerry profileBaseline on conflict
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Scan-log reasoning overrides GojiBerry profileBaseline on conflict', () => {
  it('when GojiBerry profileBaseline is truncated, scan log reasoning wins', async () => {
    const client = mockClient([
      paginated([makeGbLead({ id: '1001', profileBaseline: 'ICP Score: 98/100' })]), // truncated — only score
    ]);
    writeScanLog('scan-2026-04-16.json', {
      scanDate: '2026-04-16',
      newContacts: [
        {
          id: 1001,
          name: 'Jane Doe',
          title: 'VP Sales',
          company: 'Acme',
          vertical: 'roofing',
          fit: 'qualified',
          score: 98,
          signals: '57 acquisitions in 2025, PE-backed, Inc. 5000',
        },
      ],
    });
    await rebuildMaster({ _client: client, scanLogsDir, masterFilePath: masterFile });
    const contact: MasterContact = JSON.parse(fs.readFileSync(masterFile, 'utf8').trim());
    expect(contact.icpScore).toBe(98);
    expect(contact.intentSignals).toEqual(
      expect.arrayContaining(['57 acquisitions in 2025', 'PE-backed', 'Inc. 5000']),
    );
  });

  it('preserves GojiBerry-only fields (jobTitle, personalizedMessages) when scan log has none', async () => {
    const client = mockClient([
      paginated([makeGbLead({ id: '1001', jobTitle: 'SVP Sales', personalizedMessages: [{ content: 'Hi!', stepNumber: 1 }] } as Partial<Lead>)]),
    ]);
    writeScanLog('scan-2026-04-16.json', {
      scanDate: '2026-04-16',
      newContacts: [{ id: 1001, name: 'Jane Doe', score: 95, fit: 'qualified', signals: 'A, B' }],
    });
    await rebuildMaster({ _client: client, scanLogsDir, masterFilePath: masterFile });
    const contact: MasterContact = JSON.parse(fs.readFileSync(masterFile, 'utf8').trim());
    expect(contact.jobTitle).toBe('SVP Sales');
    expect(contact.personalizedMessages).toHaveLength(1);
    expect(contact.personalizedMessages[0].content).toBe('Hi!');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Contact in GojiBerry but not in any scan log is preserved
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Contact in GojiBerry but not in any scan log is preserved', () => {
  it('writes master row using only GojiBerry data', async () => {
    const client = mockClient([paginated([makeGbLead({ id: '9999', firstName: 'Orphan' })])]);
    await rebuildMaster({ _client: client, scanLogsDir, masterFilePath: masterFile });
    const contact: MasterContact = JSON.parse(fs.readFileSync(masterFile, 'utf8').trim());
    expect(contact.id).toBe(9999);
    expect(contact.firstName).toBe('Orphan');
    expect(contact.sources).toHaveLength(1);
    expect(contact.sources[0].type).toBe('gojiberry');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Re-running rebuild is idempotent
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Re-running rebuild is idempotent', () => {
  it('rewrites the same contacts on second run', async () => {
    const client1 = mockClient([paginated([makeGbLead({ id: '1001' })])]);
    await rebuildMaster({ _client: client1, scanLogsDir, masterFilePath: masterFile });
    const firstLines = fs.readFileSync(masterFile, 'utf8').trim().split('\n').length;

    const client2 = mockClient([paginated([makeGbLead({ id: '1001' })])]);
    await rebuildMaster({ _client: client2, scanLogsDir, masterFilePath: masterFile });
    const secondLines = fs.readFileSync(masterFile, 'utf8').trim().split('\n').length;

    expect(secondLines).toBe(firstLines);
  });

  it('preserves Apollo enrichment fields across rebuild', async () => {
    // Seed master with an Apollo-enriched contact
    const seed: MasterContact = {
      id: 1001,
      firstName: 'Jane',
      lastName: 'Doe',
      fullName: 'Jane Doe',
      profileUrl: 'https://linkedin.com/in/jane-doe',
      company: 'Acme',
      jobTitle: 'VP',
      location: 'Austin',
      icpScore: 82,
      fit: 'qualified',
      intentSignals: [],
      intentType: null,
      reasoning: null,
      personalizedMessages: [],
      email: 'jane@acme.com',
      phone: null,
      apolloPersonId: 'apollo_xyz',
      apolloEnrichedAt: '2026-04-19T00:00:00Z',
      apolloMatchConfidence: 0.88,
      gojiberryState: {
        listId: null,
        campaignStatus: null,
        readyForCampaign: false,
        bounced: false,
        unsubscribed: false,
        updatedAt: null,
      },
      sources: [{ type: 'gojiberry', ref: 'api', fetchedAt: '2026-04-19T00:00:00Z' }],
      masterUpdatedAt: '2026-04-19T00:00:00Z',
    };
    fs.writeFileSync(masterFile, JSON.stringify(seed) + '\n');

    const client = mockClient([paginated([makeGbLead({ id: '1001' })])]);
    await rebuildMaster({ _client: client, scanLogsDir, masterFilePath: masterFile });

    const contact: MasterContact = JSON.parse(fs.readFileSync(masterFile, 'utf8').trim());
    expect(contact.email).toBe('jane@acme.com');
    expect(contact.apolloPersonId).toBe('apollo_xyz');
    expect(contact.apolloEnrichedAt).toBe('2026-04-19T00:00:00Z');
    expect(contact.apolloMatchConfidence).toBe(0.88);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Rebuild with dry-run shows diff without writing
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Rebuild with dry-run shows diff without writing', () => {
  it('returns summary counts and does not touch the master file', async () => {
    const client = mockClient([paginated([makeGbLead({ id: '1001' }), makeGbLead({ id: '1002' })])]);
    const result = await rebuildMaster({
      _client: client,
      scanLogsDir,
      masterFilePath: masterFile,
      dryRun: true,
    });
    expect(result.added).toBe(2);
    expect(result.updated).toBe(0);
    expect(fs.existsSync(masterFile)).toBe(false);
  });

  it('reports updated count when master already exists', async () => {
    // Pre-populate master with one contact
    const seed: MasterContact = JSON.parse(
      JSON.stringify({
        id: 1001,
        firstName: 'Jane',
        lastName: 'Doe',
        fullName: 'Jane Doe',
        profileUrl: 'https://linkedin.com/in/jane-doe',
        company: 'Acme',
        jobTitle: 'VP',
        location: 'Austin',
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
          campaignStatus: null,
          readyForCampaign: false,
          bounced: false,
          unsubscribed: false,
          updatedAt: null,
        },
        sources: [{ type: 'gojiberry', ref: 'api', fetchedAt: '2026-04-19T00:00:00Z' }],
        masterUpdatedAt: '2026-04-19T00:00:00Z',
      }),
    );
    fs.writeFileSync(masterFile, JSON.stringify(seed) + '\n');

    const client = mockClient([paginated([makeGbLead({ id: '1001', jobTitle: 'SVP' }), makeGbLead({ id: '1002' })])]);
    const result = await rebuildMaster({
      _client: client,
      scanLogsDir,
      masterFilePath: masterFile,
      dryRun: true,
    });
    expect(result.added).toBe(1); // id=1002
    expect(result.updated).toBe(1); // id=1001 (jobTitle changed)
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: parseProfileBaseline handles all three production formats
// ──────────────────────────────────────────────────────────────────────────────

describe('parseProfileBaseline — structured format (April 15+)', () => {
  it('extracts ICP score, reasoning, and signals when all labels are present', () => {
    const pb =
      'ICP Score: 95/100\nReasoning: Director of Sales at Tecta America — 110+ locations, 6 acquisitions in 2025.\nSignals: PE-backed, 110+ locations, 6 acquisitions in 2025\n';
    const r = parseProfileBaseline(pb);
    expect(r.icpScore).toBe(95);
    expect(r.reasoning).toContain('Director of Sales at Tecta America');
    expect(r.signals).toEqual(['PE-backed', '110+ locations', '6 acquisitions in 2025']);
  });
});

describe('parseProfileBaseline — paragraph format (April 20)', () => {
  it('extracts score from "Score:" prefix (without "ICP")', () => {
    const pb =
      'Score: 88/100. ProForce Pest Control is a 110-person pest control company in Crawfordville, FL. Cory is VP of Sales with 10+ years of door-to-door experience. Signals: Golden Door winner, 10+ yrs D2D, manages territory reps.';
    const r = parseProfileBaseline(pb);
    expect(r.icpScore).toBe(88);
  });

  it('infers reasoning from paragraph between score and Signals: label', () => {
    const pb =
      'Score: 88/100. ProForce Pest Control is a 110-person pest control company in Crawfordville, FL. Cory is VP of Sales with 10+ years of door-to-door experience. Signals: Golden Door winner, 10+ yrs D2D, manages territory reps.';
    const r = parseProfileBaseline(pb);
    expect(r.reasoning).toContain('ProForce Pest Control');
    expect(r.reasoning).toContain('Cory is VP of Sales');
    expect(r.reasoning).not.toContain('Signals:');
    expect(r.reasoning).not.toMatch(/^\/100/);
  });

  it('extracts signals and strips trailing period', () => {
    const pb =
      'Score: 88/100. ProForce Pest Control is in FL. Signals: Golden Door winner, 10+ yrs D2D, manages territory reps.';
    const r = parseProfileBaseline(pb);
    expect(r.signals).toEqual(['Golden Door winner', '10+ yrs D2D', 'manages territory reps']);
  });
});

describe('parseProfileBaseline — ultra-minimal format (April 13–14)', () => {
  it('returns null reasoning and empty signals when only ICP Score is present', () => {
    const r = parseProfileBaseline('ICP Score: 78/100');
    expect(r.icpScore).toBe(78);
    expect(r.reasoning).toBeNull();
    expect(r.signals).toEqual([]);
  });

  it('returns nulls and empty array when input is empty or null', () => {
    expect(parseProfileBaseline(null)).toEqual({ icpScore: null, reasoning: null, signals: [] });
    expect(parseProfileBaseline('')).toEqual({ icpScore: null, reasoning: null, signals: [] });
    expect(parseProfileBaseline(undefined)).toEqual({ icpScore: null, reasoning: null, signals: [] });
  });
});
