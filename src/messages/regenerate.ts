import { readMaster } from '../contacts/master-store.js';
import type { MasterContact } from '../contacts/types.js';
import type { GojiBerryClient } from '../api/gojiberry-client.js';

// ──────────────────────────────────────────────────────────────────────────────
// Plan / apply split for message regeneration
//
// Mirrors /apollo-enrich: a headless plan step selects candidates, then Claude
// (in-session) generates messages, then a headless apply step writes them to
// GojiBerry via updateLead. No Anthropic SDK call, no API key — the runtime
// "generator" is Claude itself inside a Claude-Code session.
// ──────────────────────────────────────────────────────────────────────────────

export interface RegenPlanCandidate {
  id: number;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  company: string | null;
  profileUrl: string;
  icpScore: number | null;
  intentSignals: string[];
  reasoning: string | null;
  /** Whatever message is currently stored (for Claude to compare/edit/replace) */
  currentMessage: string | null;
}

export interface RegenPlan {
  runId: string;
  candidates: RegenPlanCandidate[];
  skippedByGate: Record<string, number>;
  eligible: number;
  masterFilePath: string;
}

export interface PlanRegenOptions {
  masterFilePath: string;
  /** Only consider contacts with this GojiBerry listId (e.g. 14507 for SalesEdge). */
  listId?: number;
  /** Cap number of candidates (sorted by ICP score desc). */
  limit?: number;
  /**
   * If true, include contacts that already have a message (to overwrite).
   * If false (default), only queue contacts missing a message.
   */
  force?: boolean;
  /**
   * If provided, only queue contacts whose existing message contains one of
   * these case-insensitive tokens. Useful for surgical fixes — e.g. ["gojiberry"]
   * to regenerate only the messages hallucinating the wrong product name.
   * Implies `force`.
   */
  containsTokens?: string[];
}

const GATES = {
  'not-in-list': 0,
  'not-qualified': 0,
  'no-signals': 0,
  'already-messaged': 0,
  'already-sent-in-campaign': 0,
};

function alreadySentStep1(contact: MasterContact): boolean {
  // If the contact's campaignStatus has a step-1 (message) event, the LinkedIn
  // message has already fired. Overwriting the stored message won't un-send it
  // — and could confuse future audits. Skip.
  return (contact.gojiberryState.campaignStatus ?? []).some(
    (e) => e.type === 'message' && e.stepNumber >= 1,
  );
}

function hasAnyMessage(contact: MasterContact): boolean {
  return (contact.personalizedMessages ?? []).some((m) => (m.content ?? '').length > 0);
}

function messageContainsAnyToken(contact: MasterContact, tokens: string[]): boolean {
  const lower = tokens.map((t) => t.toLowerCase());
  for (const m of contact.personalizedMessages ?? []) {
    const content = (m.content ?? '').toLowerCase();
    if (lower.some((t) => content.includes(t))) return true;
  }
  return false;
}

export async function planRegeneration(options: PlanRegenOptions): Promise<RegenPlan> {
  const contacts = await readMaster(options.masterFilePath);
  const skippedByGate: Record<string, number> = { ...GATES };
  if (options.listId === undefined) delete skippedByGate['not-in-list'];

  const force = options.force || (options.containsTokens?.length ?? 0) > 0;

  const candidates: RegenPlanCandidate[] = [];
  for (const c of contacts) {
    if (options.listId !== undefined && c.gojiberryState?.listId !== options.listId) {
      skippedByGate['not-in-list']++;
      continue;
    }
    if (c.fit !== 'qualified') {
      skippedByGate['not-qualified']++;
      continue;
    }
    if (!c.intentSignals || c.intentSignals.length === 0) {
      skippedByGate['no-signals']++;
      continue;
    }
    if (alreadySentStep1(c)) {
      skippedByGate['already-sent-in-campaign']++;
      continue;
    }

    if (options.containsTokens && options.containsTokens.length > 0) {
      if (!messageContainsAnyToken(c, options.containsTokens)) {
        skippedByGate['already-messaged']++; // misnomer here; we skip because token not found
        continue;
      }
    } else if (!force && hasAnyMessage(c)) {
      skippedByGate['already-messaged']++;
      continue;
    }

    candidates.push({
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      jobTitle: c.jobTitle,
      company: c.company,
      profileUrl: c.profileUrl,
      icpScore: c.icpScore,
      intentSignals: c.intentSignals,
      reasoning: c.reasoning,
      currentMessage: c.personalizedMessages?.[0]?.content ?? null,
    });
  }

  candidates.sort((a, b) => (b.icpScore ?? 0) - (a.icpScore ?? 0));
  const selected = options.limit !== undefined ? candidates.slice(0, options.limit) : candidates;

  return {
    runId: cryptoRandomId(),
    candidates: selected,
    skippedByGate,
    eligible: selected.length,
    masterFilePath: options.masterFilePath,
  };
}

function cryptoRandomId(): string {
  // Avoid importing crypto.randomUUID at module top so this file is test-friendly.
  // Good-enough uniqueness for a run-id timestamped to the current second.
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Apply
// ──────────────────────────────────────────────────────────────────────────────

export interface RegenResult {
  contactId: number;
  message: string;
}

export interface ApplyMessagesOptions {
  plan: RegenPlan;
  results: RegenResult[];
  _client: Pick<GojiBerryClient, 'updateLead'>;
}

export interface ApplySummary {
  written: number;
  skipped: number;
  failed: Array<{ contactId: number; error: string }>;
}

export async function applyMessages(options: ApplyMessagesOptions): Promise<ApplySummary> {
  const planIds = new Set(options.plan.candidates.map((c) => c.id));
  const summary: ApplySummary = { written: 0, skipped: 0, failed: [] };

  for (const { contactId, message } of options.results) {
    if (!planIds.has(contactId)) {
      // Generated a message for a contact that wasn't in the plan — reject.
      summary.skipped++;
      continue;
    }
    if (!message || message.trim().length === 0) {
      summary.skipped++;
      continue;
    }
    try {
      await options._client.updateLead(String(contactId), {
        personalizedMessages: [{ content: message, stepNumber: 1 }],
      } as Parameters<Pick<GojiBerryClient, 'updateLead'>['updateLead']>[1]);
      summary.written++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.failed.push({ contactId, error: msg });
    }
  }

  return summary;
}
