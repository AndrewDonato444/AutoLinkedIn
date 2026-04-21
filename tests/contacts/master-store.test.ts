import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  readMaster,
  writeMaster,
  mergeContact,
} from '../../src/contacts/master-store.js';
import type { MasterContact } from '../../src/contacts/types.js';

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
    intentSignals: ['Hiring SDRs'],
    intentType: 'hiring',
    reasoning: 'Growing team',
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
    sources: [{ type: 'gojiberry', ref: 'api', fetchedAt: '2026-04-20T00:00:00Z' }],
    masterUpdatedAt: '2026-04-20T00:00:00Z',
    ...overrides,
  };
}

let tmpDir: string;
let tmpFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'master-store-'));
  tmpFile = path.join(tmpDir, 'contacts.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('readMaster', () => {
  it('returns empty array when file does not exist', async () => {
    const result = await readMaster(tmpFile);
    expect(result).toEqual([]);
  });

  it('parses JSONL file into array of MasterContact', async () => {
    const a = makeMaster({ id: 1 });
    const b = makeMaster({ id: 2 });
    fs.writeFileSync(tmpFile, JSON.stringify(a) + '\n' + JSON.stringify(b) + '\n');
    const result = await readMaster(tmpFile);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
    expect(result[1].id).toBe(2);
  });

  it('skips empty lines in JSONL', async () => {
    const a = makeMaster({ id: 1 });
    fs.writeFileSync(tmpFile, JSON.stringify(a) + '\n\n\n');
    const result = await readMaster(tmpFile);
    expect(result).toHaveLength(1);
  });

  it('throws on malformed JSON line with context', async () => {
    fs.writeFileSync(tmpFile, '{bad json}\n');
    await expect(readMaster(tmpFile)).rejects.toThrow(/line 1/i);
  });
});

describe('writeMaster', () => {
  it('writes contacts as JSONL, one line per contact', async () => {
    const contacts = [makeMaster({ id: 1 }), makeMaster({ id: 2 })];
    await writeMaster(tmpFile, contacts);
    const content = fs.readFileSync(tmpFile, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe(1);
    expect(JSON.parse(lines[1]).id).toBe(2);
  });

  it('writes empty file when contacts array is empty', async () => {
    await writeMaster(tmpFile, []);
    const content = fs.readFileSync(tmpFile, 'utf8');
    expect(content).toBe('');
  });

  it('creates parent directory if missing', async () => {
    const nestedFile = path.join(tmpDir, 'nested', 'dir', 'contacts.jsonl');
    await writeMaster(nestedFile, [makeMaster()]);
    expect(fs.existsSync(nestedFile)).toBe(true);
  });

  it('round-trips: write then read produces identical contacts', async () => {
    const original = [makeMaster({ id: 1, firstName: 'Alpha' }), makeMaster({ id: 2, firstName: 'Beta' })];
    await writeMaster(tmpFile, original);
    const readBack = await readMaster(tmpFile);
    expect(readBack).toEqual(original);
  });
});

describe('mergeContact', () => {
  it('returns incoming as-is when no existing contact', () => {
    const incoming = makeMaster({ id: 1 });
    const result = mergeContact(null, incoming);
    expect(result).toEqual(incoming);
  });

  it('preserves Apollo fields from existing when incoming has them null', () => {
    const existing = makeMaster({
      id: 1,
      email: 'adam@hollandroofing.com',
      apolloPersonId: 'apollo_abc',
      apolloEnrichedAt: '2026-04-19T00:00:00Z',
      apolloMatchConfidence: 0.9,
    });
    const incoming = makeMaster({
      id: 1,
      email: null,
      apolloPersonId: null,
      apolloEnrichedAt: null,
      apolloMatchConfidence: null,
    });
    const result = mergeContact(existing, incoming);
    expect(result.email).toBe('adam@hollandroofing.com');
    expect(result.apolloPersonId).toBe('apollo_abc');
    expect(result.apolloEnrichedAt).toBe('2026-04-19T00:00:00Z');
    expect(result.apolloMatchConfidence).toBe(0.9);
  });

  it('merges sources array, deduplicating by ref', () => {
    const existing = makeMaster({
      id: 1,
      sources: [{ type: 'scan-log', ref: 'scan-2026-04-16.json', fetchedAt: '2026-04-16T00:00:00Z' }],
    });
    const incoming = makeMaster({
      id: 1,
      sources: [
        { type: 'scan-log', ref: 'scan-2026-04-16.json', fetchedAt: '2026-04-16T00:00:00Z' },
        { type: 'gojiberry', ref: 'api', fetchedAt: '2026-04-20T00:00:00Z' },
      ],
    });
    const result = mergeContact(existing, incoming);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.map((s) => s.ref).sort()).toEqual(['api', 'scan-2026-04-16.json']);
  });

  it('incoming reasoning/signals overrides existing (scan-log wins during rebuild)', () => {
    const existing = makeMaster({ id: 1, reasoning: 'Old', intentSignals: ['Old signal'], icpScore: 70 });
    const incoming = makeMaster({ id: 1, reasoning: 'Fresh from scan log', intentSignals: ['New signal'], icpScore: 85 });
    const result = mergeContact(existing, incoming);
    expect(result.reasoning).toBe('Fresh from scan log');
    expect(result.intentSignals).toEqual(['New signal']);
    expect(result.icpScore).toBe(85);
  });

  it('refreshes masterUpdatedAt to incoming timestamp', () => {
    const existing = makeMaster({ id: 1, masterUpdatedAt: '2026-04-19T00:00:00Z' });
    const incoming = makeMaster({ id: 1, masterUpdatedAt: '2026-04-20T12:00:00Z' });
    const result = mergeContact(existing, incoming);
    expect(result.masterUpdatedAt).toBe('2026-04-20T12:00:00Z');
  });
});
