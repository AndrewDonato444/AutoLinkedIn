import fs from 'fs';
import path from 'path';
import type { Lead, PaginatedLeads } from '../api/types.js';
import { GojiBerryClient } from '../api/gojiberry-client.js';
import { readMaster, writeMaster, mergeContact } from './master-store.js';
import type {
  MasterContact,
  MasterContactGojiberryState,
  MasterContactSource,
} from './types.js';

interface RebuildClient {
  searchLeads(filters?: { page?: number; pageSize?: number }): Promise<PaginatedLeads>;
}

export interface RebuildOptions {
  _client?: RebuildClient;
  scanLogsDir: string;
  masterFilePath: string;
  dryRun?: boolean;
}

export interface RebuildResult {
  added: number;
  updated: number;
  unchanged: number;
}

const PAGE_SIZE = 100;

interface ScanLogEntry {
  id: number;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  jobTitle?: string;
  company?: string;
  location?: string;
  profileUrl?: string;
  icpScore?: number;
  fit?: string;
  intentSignals?: string[];
  reasoning?: string;
  scanFile: string;
  scanDate: string;
}

/**
 * Parses a GojiBerry `profileBaseline` string into structured fields.
 *
 * Handles three known formats in production data:
 *
 * 1. **Structured** (April 15+ scans):
 *    `ICP Score: 95/100\nReasoning: ...\nSignals: a, b, c\n`
 *
 * 2. **Paragraph** (April 20 scans):
 *    `Score: 88/100. [rich paragraph about the person]. Signals: a, b, c.`
 *    Reasoning has no explicit label — it's the text between the score and Signals.
 *
 * 3. **Ultra-minimal** (April 13–14 scans):
 *    `ICP Score: 78/100` — no reasoning, no signals. Returns nulls/empties.
 */
export function parseProfileBaseline(pb: string | null | undefined): {
  icpScore: number | null;
  reasoning: string | null;
  signals: string[];
} {
  if (!pb) return { icpScore: null, reasoning: null, signals: [] };

  // Accept both "ICP Score: X" and "Score: X"
  const scoreMatch = pb.match(/(?:ICP\s+)?Score:\s*(\d+)/i);
  const icpScore = scoreMatch ? parseInt(scoreMatch[1], 10) : null;

  // Signals: always labeled when present. Capture until end-of-text.
  // Trim trailing period (paragraph format ends "...Signals: x, y, z.")
  const signalsMatch = pb.match(/Signals:\s*([\s\S]+?)(?=\n\s*$|$)/i);
  const signals = signalsMatch
    ? signalsMatch[1]
        .trim()
        .replace(/\.\s*$/, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // Reasoning: labeled (structured) OR inferred (paragraph) OR absent (ultra-minimal).
  let reasoning: string | null = null;
  const labeledReasoning = pb.match(/Reasoning:\s*([\s\S]+?)(?=\n\s*Signals:|$)/i);
  if (labeledReasoning) {
    reasoning = labeledReasoning[1].trim();
  } else if (scoreMatch && signalsMatch) {
    // Paragraph format: extract text between end of score match and start of "Signals:"
    const scoreEnd = pb.indexOf(scoreMatch[0]) + scoreMatch[0].length;
    const signalsStart = pb.indexOf(signalsMatch[0]);
    if (signalsStart > scoreEnd) {
      const between = pb.slice(scoreEnd, signalsStart).trim();
      // Strip leading "/100." or ". " fragments left over from score-line boundary
      const cleaned = between.replace(/^\/?\d*\s*[.:]?\s*/, '').trim();
      reasoning = cleaned || null;
    }
  }

  return { icpScore, reasoning, signals };
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function parseScanLogEntries(scanLogsDir: string): ScanLogEntry[] {
  if (!fs.existsSync(scanLogsDir)) return [];
  const files = fs.readdirSync(scanLogsDir).filter((f) => f.endsWith('.json'));
  const entries: ScanLogEntry[] = [];

  for (const file of files) {
    const body = JSON.parse(fs.readFileSync(path.join(scanLogsDir, file), 'utf8'));
    const scanDate: string = body.scanDate ?? file;

    const collectFrom = (arr: unknown[] | undefined): void => {
      if (!Array.isArray(arr)) return;
      for (const raw of arr) {
        const c = raw as Record<string, unknown>;
        const id = Number(c.gojiberry_id ?? c.id ?? 0);
        if (!id) continue;
        const name = (c.fullName as string) ?? (c.name as string) ?? '';
        const { firstName: fnFromName, lastName: lnFromName } = splitName(name);
        const signalsField = c.signals;
        const splitCsv = (s: string): string[] =>
          s.split(',').map((x) => x.trim()).filter(Boolean);
        const intentSignals: string[] | undefined =
          typeof signalsField === 'string'
            ? splitCsv(signalsField)
            : Array.isArray(signalsField)
              ? (signalsField as string[])
              : typeof c.keySignal === 'string'
                ? splitCsv(c.keySignal as string)
                : undefined;

        entries.push({
          id,
          firstName: (c.firstName as string) ?? fnFromName ?? undefined,
          lastName: (c.lastName as string) ?? lnFromName ?? undefined,
          fullName: (c.fullName as string) ?? name ?? undefined,
          jobTitle: (c.jobTitle as string) ?? (c.title as string) ?? undefined,
          company: (c.company as string) ?? undefined,
          location: (c.location as string) ?? undefined,
          profileUrl: (c.profileUrl as string) ?? undefined,
          icpScore:
            typeof c.icpScore === 'number'
              ? (c.icpScore as number)
              : typeof c.score === 'number'
                ? (c.score as number)
                : undefined,
          fit: (c.fit as string) ?? undefined,
          intentSignals,
          reasoning: (c.reasoning as string) ?? undefined,
          scanFile: file,
          scanDate,
        });
      }
    };

    collectFrom(body.contacts);
    collectFrom(body.newContacts);
    collectFrom(body.existingContacts);
  }

  return entries;
}

async function fetchAllGojiberry(client: RebuildClient): Promise<Lead[]> {
  const all: Lead[] = [];
  let page = 1;
  while (true) {
    const result = await client.searchLeads({ page, pageSize: PAGE_SIZE });
    if (!result.leads || result.leads.length === 0) break;
    all.push(...result.leads);
    if (result.total !== undefined && all.length >= result.total) break;
    page++;
    if (page > 100) break;
  }
  return all;
}

function defaultGojiberryState(): MasterContactGojiberryState {
  return {
    listId: null,
    campaignStatus: null,
    readyForCampaign: false,
    bounced: false,
    unsubscribed: false,
    updatedAt: null,
  };
}

function leadToMaster(lead: Lead, fetchedAt: string): MasterContact {
  const rawLead = lead as unknown as Record<string, unknown>;
  const { icpScore, reasoning, signals } = parseProfileBaseline(lead.profileBaseline);
  return {
    id: Number(lead.id),
    firstName: lead.firstName ?? '',
    lastName: lead.lastName ?? '',
    fullName: `${lead.firstName ?? ''} ${lead.lastName ?? ''}`.trim(),
    profileUrl: lead.profileUrl ?? '',
    company: lead.company ?? null,
    jobTitle: lead.jobTitle ?? null,
    location: lead.location ?? null,

    icpScore,
    fit: (lead.fit as MasterContact['fit']) ?? null,
    intentSignals: signals,
    intentType: (lead.intent_type as string | undefined) ?? (lead.intentType as string | undefined) ?? null,
    reasoning,
    personalizedMessages: lead.personalizedMessages ?? [],

    email: (rawLead.email as string | null) ?? null,
    phone: (rawLead.phone as string | null) ?? null,
    apolloPersonId: null,
    apolloEnrichedAt: null,
    apolloMatchConfidence: null,

    gojiberryState: {
      listId: typeof rawLead.listId === 'number' ? (rawLead.listId as number) : null,
      campaignStatus: (rawLead.campaignStatus as string | null) ?? null,
      readyForCampaign: rawLead.readyForCampaign === true,
      bounced: rawLead.bounced === true,
      unsubscribed: rawLead.unsubscribed === true,
      updatedAt: (rawLead.updatedAt as string | null) ?? null,
    },

    sources: [{ type: 'gojiberry', ref: 'api', fetchedAt }],

    masterUpdatedAt: fetchedAt,
  };
}

function applyScanLogEntry(base: MasterContact, entry: ScanLogEntry): MasterContact {
  const source: MasterContactSource = {
    type: 'scan-log',
    ref: entry.scanFile,
    fetchedAt: entry.scanDate,
  };

  return {
    ...base,
    firstName: base.firstName || entry.firstName || '',
    lastName: base.lastName || entry.lastName || '',
    fullName: base.fullName || entry.fullName || `${entry.firstName ?? ''} ${entry.lastName ?? ''}`.trim(),
    profileUrl: base.profileUrl || entry.profileUrl || '',
    company: base.company ?? entry.company ?? null,
    jobTitle: base.jobTitle ?? entry.jobTitle ?? null,
    location: base.location ?? entry.location ?? null,

    icpScore: entry.icpScore ?? base.icpScore,
    fit: (entry.fit as MasterContact['fit']) ?? base.fit,
    // Richer source wins: prefer whichever has MORE signals (scan-log may only
    // carry a single-line "keySignal" summary while GojiBerry's profileBaseline
    // can have a full comma-separated list — or vice versa when GojiBerry was
    // overwritten with truncated data).
    intentSignals:
      (entry.intentSignals?.length ?? 0) > base.intentSignals.length
        ? entry.intentSignals!
        : base.intentSignals,
    reasoning:
      entry.reasoning && (!base.reasoning || entry.reasoning.length > base.reasoning.length)
        ? entry.reasoning
        : base.reasoning,

    sources: [...base.sources, source],
  };
}

function buildScanLogOnlyContact(entries: ScanLogEntry[], fetchedAt: string): MasterContact {
  const first = entries[0];
  return {
    id: first.id,
    firstName: first.firstName ?? '',
    lastName: first.lastName ?? '',
    fullName: first.fullName ?? `${first.firstName ?? ''} ${first.lastName ?? ''}`.trim(),
    profileUrl: first.profileUrl ?? '',
    company: first.company ?? null,
    jobTitle: first.jobTitle ?? null,
    location: first.location ?? null,

    icpScore: first.icpScore ?? null,
    fit: (first.fit as MasterContact['fit']) ?? null,
    intentSignals: first.intentSignals ?? [],
    intentType: null,
    reasoning: first.reasoning ?? null,
    personalizedMessages: [],

    email: null,
    phone: null,
    apolloPersonId: null,
    apolloEnrichedAt: null,
    apolloMatchConfidence: null,

    gojiberryState: defaultGojiberryState(),

    sources: entries.map((e) => ({
      type: 'scan-log' as const,
      ref: e.scanFile,
      fetchedAt: e.scanDate,
    })),

    masterUpdatedAt: fetchedAt,
  };
}

function contactsEqual(a: MasterContact, b: MasterContact): boolean {
  const strip = (c: MasterContact) => {
    const { masterUpdatedAt: _a, ...rest } = c;
    void _a;
    return rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

export async function rebuildMaster(options: RebuildOptions): Promise<RebuildResult> {
  const client = options._client ?? new GojiBerryClient();
  const fetchedAt = new Date().toISOString();

  const [leads, existing] = await Promise.all([
    fetchAllGojiberry(client),
    readMaster(options.masterFilePath),
  ]);

  const scanEntries = parseScanLogEntries(options.scanLogsDir);
  const scanById = new Map<number, ScanLogEntry[]>();
  for (const e of scanEntries) {
    const arr = scanById.get(e.id) ?? [];
    arr.push(e);
    scanById.set(e.id, arr);
  }

  const existingById = new Map<number, MasterContact>();
  for (const c of existing) existingById.set(c.id, c);

  const nextById = new Map<number, MasterContact>();

  for (const lead of leads) {
    const id = Number(lead.id);
    let contact = leadToMaster(lead, fetchedAt);
    const entries = scanById.get(id) ?? [];
    for (const entry of entries) {
      contact = applyScanLogEntry(contact, entry);
    }
    const merged = mergeContact(existingById.get(id) ?? null, contact);
    nextById.set(id, merged);
  }

  for (const [id, entries] of scanById) {
    if (nextById.has(id)) continue;
    const scanOnly = buildScanLogOnlyContact(entries, fetchedAt);
    const merged = mergeContact(existingById.get(id) ?? null, scanOnly);
    nextById.set(id, merged);
  }

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const [id, next] of nextById) {
    const prev = existingById.get(id);
    if (!prev) {
      added++;
    } else if (contactsEqual(prev, next)) {
      unchanged++;
    } else {
      updated++;
    }
  }

  if (!options.dryRun) {
    const sorted = Array.from(nextById.values()).sort((a, b) => a.id - b.id);
    await writeMaster(options.masterFilePath, sorted);
  }

  return { added, updated, unchanged };
}
