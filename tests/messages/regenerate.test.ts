import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { planRegeneration, applyMessages } from '../../src/messages/regenerate.js';
import type { MasterContact } from '../../src/contacts/types.js';

function makeMaster(overrides: Partial<MasterContact> = {}): MasterContact {
  return {
    id: 1,
    firstName: 'Jane',
    lastName: 'Doe',
    fullName: 'Jane Doe',
    profileUrl: 'https://linkedin.com/in/jane-doe',
    company: 'Acme',
    jobTitle: 'VP Sales',
    location: 'Austin',
    icpScore: 82,
    fit: 'qualified',
    intentSignals: ['Hiring SDRs', 'Series B'],
    intentType: null,
    reasoning: 'Growing team',
    personalizedMessages: [],
    email: null,
    phone: null,
    apolloPersonId: null,
    apolloEnrichedAt: null,
    apolloMatchConfidence: null,
    gojiberryState: {
      listId: 14507,
      campaignStatus: [],
      readyForCampaign: false,
      bounced: false,
      unsubscribed: false,
      updatedAt: null,
    },
    sources: [],
    masterUpdatedAt: '2026-04-21T00:00:00Z',
    ...overrides,
  };
}

let tmpDir: string;
let masterFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-'));
  masterFile = path.join(tmpDir, 'contacts.jsonl');
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeMaster(contacts: MasterContact[]): void {
  fs.writeFileSync(masterFile, contacts.map((c) => JSON.stringify(c)).join('\n') + '\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// planRegeneration
// ──────────────────────────────────────────────────────────────────────────────

describe('planRegeneration', () => {
  it('queues qualified contacts with signals but no message', async () => {
    writeMaster([makeMaster({ id: 1, personalizedMessages: [] })]);
    const plan = await planRegeneration({ masterFilePath: masterFile });
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].id).toBe(1);
  });

  it('skips contacts missing intentSignals (would generate a generic message)', async () => {
    writeMaster([makeMaster({ id: 1, intentSignals: [] })]);
    const plan = await planRegeneration({ masterFilePath: masterFile });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.skippedByGate['no-signals']).toBe(1);
  });

  it('skips contacts not marked qualified', async () => {
    writeMaster([makeMaster({ id: 1, fit: 'unknown' })]);
    const plan = await planRegeneration({ masterFilePath: masterFile });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.skippedByGate['not-qualified']).toBe(1);
  });

  it('skips contacts that already have a message by default', async () => {
    writeMaster([
      makeMaster({
        id: 1,
        personalizedMessages: [{ content: 'existing message', stepNumber: 1 }],
      }),
    ]);
    const plan = await planRegeneration({ masterFilePath: masterFile });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.skippedByGate['already-messaged']).toBe(1);
  });

  it('queues contacts with existing messages when force=true', async () => {
    writeMaster([
      makeMaster({
        id: 1,
        personalizedMessages: [{ content: 'existing message', stepNumber: 1 }],
      }),
    ]);
    const plan = await planRegeneration({ masterFilePath: masterFile, force: true });
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].currentMessage).toBe('existing message');
  });

  it('skips contacts where step-1 message has already been sent in campaign', async () => {
    writeMaster([
      makeMaster({
        id: 1,
        personalizedMessages: [{ content: 'bad message', stepNumber: 1 }],
        gojiberryState: {
          listId: 14507,
          campaignStatus: [
            { type: 'invitation', state: 'accepted', createdAt: '2026-04-20T10:00:00Z', stepNumber: 0 },
            { type: 'message', state: 'sent', createdAt: '2026-04-20T19:18:13Z', stepNumber: 1 },
          ],
          readyForCampaign: true,
          bounced: false,
          unsubscribed: false,
          updatedAt: null,
        },
      }),
    ]);
    const plan = await planRegeneration({ masterFilePath: masterFile, force: true });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.skippedByGate['already-sent-in-campaign']).toBe(1);
  });

  it('filters by listId when provided', async () => {
    writeMaster([
      makeMaster({ id: 1, gojiberryState: { ...makeMaster().gojiberryState, listId: 14507 } }),
      makeMaster({ id: 2, gojiberryState: { ...makeMaster().gojiberryState, listId: 99 } }),
    ]);
    const plan = await planRegeneration({ masterFilePath: masterFile, listId: 14507 });
    expect(plan.candidates.map((c) => c.id)).toEqual([1]);
    expect(plan.skippedByGate['not-in-list']).toBe(1);
  });

  it('containsTokens: only queues contacts whose existing message matches a token', async () => {
    writeMaster([
      makeMaster({
        id: 1,
        personalizedMessages: [{ content: 'this pitches GojiBerry — bug!', stepNumber: 1 }],
      }),
      makeMaster({
        id: 2,
        personalizedMessages: [{ content: 'this pitches SalesEdge correctly', stepNumber: 1 }],
      }),
    ]);
    const plan = await planRegeneration({
      masterFilePath: masterFile,
      containsTokens: ['gojiberry'],
    });
    expect(plan.candidates.map((c) => c.id)).toEqual([1]);
  });

  it('sorts candidates by ICP score descending and respects limit', async () => {
    writeMaster([
      makeMaster({ id: 1, icpScore: 60 }),
      makeMaster({ id: 2, icpScore: 95 }),
      makeMaster({ id: 3, icpScore: 75 }),
    ]);
    const plan = await planRegeneration({ masterFilePath: masterFile, limit: 2 });
    expect(plan.candidates.map((c) => c.id)).toEqual([2, 3]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// applyMessages
// ──────────────────────────────────────────────────────────────────────────────

describe('applyMessages', () => {
  it('writes each result to GojiBerry via updateLead', async () => {
    writeMaster([makeMaster({ id: 1 }), makeMaster({ id: 2 })]);
    const plan = await planRegeneration({ masterFilePath: masterFile });
    const updateLead = vi.fn().mockResolvedValue({});
    const summary = await applyMessages({
      plan,
      results: [
        { contactId: 1, message: 'new-msg-1' },
        { contactId: 2, message: 'new-msg-2' },
      ],
      _client: { updateLead },
    });
    expect(summary.written).toBe(2);
    expect(updateLead).toHaveBeenCalledTimes(2);
    expect(updateLead).toHaveBeenCalledWith('1', expect.objectContaining({
      personalizedMessages: [{ content: 'new-msg-1', stepNumber: 1 }],
    }));
  });

  it('rejects results for contacts not in the plan (safety against wrong-id writes)', async () => {
    writeMaster([makeMaster({ id: 1 })]);
    const plan = await planRegeneration({ masterFilePath: masterFile });
    const updateLead = vi.fn().mockResolvedValue({});
    const summary = await applyMessages({
      plan,
      results: [
        { contactId: 1, message: 'ok' },
        { contactId: 999, message: 'rogue' }, // not in plan
      ],
      _client: { updateLead },
    });
    expect(summary.written).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(updateLead).toHaveBeenCalledTimes(1);
  });

  it('skips empty or whitespace messages without calling updateLead', async () => {
    writeMaster([makeMaster({ id: 1 })]);
    const plan = await planRegeneration({ masterFilePath: masterFile });
    const updateLead = vi.fn().mockResolvedValue({});
    const summary = await applyMessages({
      plan,
      results: [{ contactId: 1, message: '   ' }],
      _client: { updateLead },
    });
    expect(summary.skipped).toBe(1);
    expect(updateLead).not.toHaveBeenCalled();
  });

  it('captures per-contact errors in the summary (one failure does not abort the run)', async () => {
    writeMaster([makeMaster({ id: 1 }), makeMaster({ id: 2 })]);
    const plan = await planRegeneration({ masterFilePath: masterFile });
    const updateLead = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limit'))
      .mockResolvedValueOnce({});
    const summary = await applyMessages({
      plan,
      results: [
        { contactId: 1, message: 'a' },
        { contactId: 2, message: 'b' },
      ],
      _client: { updateLead },
    });
    expect(summary.written).toBe(1);
    expect(summary.failed).toEqual([{ contactId: 1, error: 'rate limit' }]);
  });
});
