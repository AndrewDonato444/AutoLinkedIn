import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { syncGojiberryState } from '../../src/contacts/gojiberry-sync.js';
import type { MasterContact } from '../../src/contacts/types.js';
import type { Lead } from '../../src/api/types.js';

function makeMaster(overrides: Partial<MasterContact> = {}): MasterContact {
  return {
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
    sources: [],
    masterUpdatedAt: '2026-04-19T00:00:00Z',
    ...overrides,
  };
}

function writeMasterFile(masterFile: string, contacts: MasterContact[]): void {
  fs.writeFileSync(masterFile, contacts.map((c) => JSON.stringify(c)).join('\n') + (contacts.length ? '\n' : ''));
}

function readMasterFile(masterFile: string): MasterContact[] {
  return fs
    .readFileSync(masterFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as MasterContact);
}

let tmpDir: string;
let masterFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gojiberry-sync-'));
  masterFile = path.join(tmpDir, 'contacts.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Pulls engagement state into master
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Pulls engagement state into master', () => {
  it('updates bounced, unsubscribed, campaignStatus, listId, readyForCampaign from GojiBerry', async () => {
    writeMasterFile(masterFile, [makeMaster({ id: 4724299 })]);
    const getLead = vi.fn().mockResolvedValue({
      id: '4724299',
      firstName: 'Jane',
      lastName: 'Doe',
      profileUrl: 'https://linkedin.com/in/jane-doe',
      bounced: true,
      unsubscribed: false,
      campaignStatus: 'active',
      listId: 14507,
      readyForCampaign: true,
      updatedAt: '2026-04-20T10:00:00Z',
    } as unknown as Lead);
    const client = { getLead };

    await syncGojiberryState({ masterFilePath: masterFile, _client: client });

    const [contact] = readMasterFile(masterFile);
    expect(contact.gojiberryState.bounced).toBe(true);
    expect(contact.gojiberryState.unsubscribed).toBe(false);
    expect(contact.gojiberryState.campaignStatus).toBe('active');
    expect(contact.gojiberryState.listId).toBe(14507);
    expect(contact.gojiberryState.readyForCampaign).toBe(true);
    expect(contact.gojiberryState.updatedAt).toBe('2026-04-20T10:00:00Z');
  });

  it('refreshes masterUpdatedAt after sync', async () => {
    writeMasterFile(masterFile, [makeMaster({ id: 1, masterUpdatedAt: '2026-04-19T00:00:00Z' })]);
    const getLead = vi.fn().mockResolvedValue({
      id: '1',
      firstName: 'Jane',
      lastName: 'Doe',
      profileUrl: 'https://linkedin.com/in/jane-doe',
      bounced: false,
      updatedAt: '2026-04-20T10:00:00Z',
    } as unknown as Lead);
    await syncGojiberryState({ masterFilePath: masterFile, _client: { getLead } });
    const [contact] = readMasterFile(masterFile);
    expect(contact.masterUpdatedAt).not.toBe('2026-04-19T00:00:00Z');
  });

  it('does not touch Apollo fields during sync', async () => {
    writeMasterFile(masterFile, [
      makeMaster({
        id: 1,
        email: 'jane@acme.com',
        apolloPersonId: 'apollo_xyz',
        apolloEnrichedAt: '2026-04-19T00:00:00Z',
        apolloMatchConfidence: 0.88,
      }),
    ]);
    const getLead = vi.fn().mockResolvedValue({
      id: '1',
      firstName: 'Jane',
      lastName: 'Doe',
      profileUrl: 'https://linkedin.com/in/jane-doe',
      bounced: true,
      updatedAt: '2026-04-20T10:00:00Z',
    } as unknown as Lead);
    await syncGojiberryState({ masterFilePath: masterFile, _client: { getLead } });
    const [contact] = readMasterFile(masterFile);
    expect(contact.email).toBe('jane@acme.com');
    expect(contact.apolloPersonId).toBe('apollo_xyz');
    expect(contact.apolloEnrichedAt).toBe('2026-04-19T00:00:00Z');
    expect(contact.apolloMatchConfidence).toBe(0.88);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Contact removed from GojiBerry — flag in master
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Contact removed from GojiBerry', () => {
  it('flags deletedFromGojiberry=true when GojiBerry 404s', async () => {
    writeMasterFile(masterFile, [makeMaster({ id: 4700000 })]);
    const { NotFoundError } = await import('../../src/api/errors.js');
    const getLead = vi.fn().mockRejectedValue(new NotFoundError('Lead', '4700000'));
    const result = await syncGojiberryState({ masterFilePath: masterFile, _client: { getLead } });
    const [contact] = readMasterFile(masterFile);
    expect(contact.deletedFromGojiberry).toBe(true);
    expect(result.deleted).toBe(1);
  });

  it('does not remove the master row for a deleted GojiBerry contact', async () => {
    writeMasterFile(masterFile, [makeMaster({ id: 4700000 })]);
    const { NotFoundError } = await import('../../src/api/errors.js');
    const getLead = vi.fn().mockRejectedValue(new NotFoundError('Lead', '4700000'));
    await syncGojiberryState({ masterFilePath: masterFile, _client: { getLead } });
    const contacts = readMasterFile(masterFile);
    expect(contacts).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Sync never PATCHes GojiBerry
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Sync is read-only on GojiBerry side', () => {
  it('never calls updateLead', async () => {
    writeMasterFile(masterFile, [makeMaster({ id: 1 })]);
    const getLead = vi.fn().mockResolvedValue({
      id: '1',
      firstName: 'Jane',
      lastName: 'Doe',
      profileUrl: 'https://linkedin.com/in/jane-doe',
      updatedAt: '2026-04-20T00:00:00Z',
    } as unknown as Lead);
    const updateLead = vi.fn();
    await syncGojiberryState({
      masterFilePath: masterFile,
      _client: { getLead, updateLead } as unknown as { getLead: typeof getLead },
    });
    expect(updateLead).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Scenario: Result summary
// ──────────────────────────────────────────────────────────────────────────────

describe('Scenario: Result summary', () => {
  it('returns synced count', async () => {
    writeMasterFile(masterFile, [makeMaster({ id: 1 }), makeMaster({ id: 2 })]);
    const getLead = vi.fn().mockResolvedValue({
      id: '1',
      firstName: 'Jane',
      lastName: 'Doe',
      profileUrl: 'https://linkedin.com/in/jane-doe',
      updatedAt: '2026-04-20T00:00:00Z',
    } as unknown as Lead);
    const result = await syncGojiberryState({ masterFilePath: masterFile, _client: { getLead } });
    expect(result.synced).toBe(2);
  });
});
