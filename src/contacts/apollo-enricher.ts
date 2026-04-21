import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { readMaster, writeMaster } from './master-store.js';
import type {
  ApolloClient,
  ApolloMatchInput,
  EnrichmentLogEntry,
  EnrichmentOutcome,
  MasterContact,
} from './types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Plan / apply split — supports MCP-driven enrichment (Claude calls MCP, then
// feeds results to applyEnrichmentResults). Node subprocesses cannot call MCP
// tools directly, so the flow is: plan → Claude MCP calls → apply.
// ──────────────────────────────────────────────────────────────────────────────

export interface EnrichmentPlanBatchDetail {
  id: string;
  linkedin_url: string;
  first_name: string;
  last_name: string;
  organization_name: string;
}

export interface EnrichmentPlanBatch {
  batchIndex: number;
  details: EnrichmentPlanBatchDetail[];
}

export interface EnrichmentPlan {
  runId: string;
  batches: EnrichmentPlanBatch[];
  eligible: number;
  projectedCredits: number;
  creditsAlreadyUsed: number;
  budgetRemaining: number;
  skippedByGate: Record<string, number>;
  warnings: string[];
  masterFilePath: string;
  logFilePath: string;
}

export interface EnrichmentResult {
  contactId: number;
  match: boolean;
  email?: string | null;
  personId?: string | null;
  confidence?: number;
  error?: string;
}

export interface PlanOptions {
  masterFilePath: string;
  logFilePath: string;
  runBudget: number;
  totalBudget: number;
  batchSize?: number;
  limit?: number;
  /**
   * Restrict enrichment to contacts whose `gojiberryState.listId` matches.
   * Useful for targeting a specific campaign's list (e.g. SalesEdge=14507).
   * Omit to consider all eligible contacts across master.
   */
  listId?: number;
}

export interface EnrichOptions extends PlanOptions {
  _apollo: ApolloClient;
  apply: boolean;
}

export interface EnrichResult {
  eligible: number;
  projectedCredits: number;
  enriched: number;
  creditsUsed: number;
  skippedByGate: Record<string, number>;
  outcomes: Record<EnrichmentOutcome, number>;
  warnings: string[];
}

const DEFAULT_BATCH_SIZE = 10;

// Re-exported from shared util so existing imports keep working.
export { normalizeLinkedInUrl } from '../utils/linkedin-url.js';
import { normalizeLinkedInUrl as normUrl } from '../utils/linkedin-url.js';

/**
 * Raw Apollo MCP bulk_match response shape — only the fields we consume.
 * Apollo may return additional fields (organization, employment_history, etc.)
 * which we ignore.
 */
export interface ApolloRawMatch {
  id?: string;
  linkedin_url?: string;
  email?: string | null;
  email_status?: string;
}

export interface ApolloRawBulkResponse {
  matches?: ApolloRawMatch[];
  missing_records?: number;
  credits_consumed?: number;
  status?: string;
}

/**
 * Correlate a raw Apollo bulk_match response back to our plan's contact IDs
 * by normalized LinkedIn URL. Contacts in the plan that have no matching
 * response become `match: false` (no-match outcome on apply).
 */
export function correlateApolloResponse(
  plan: EnrichmentPlan,
  response: ApolloRawBulkResponse,
): EnrichmentResult[] {
  const matchesByUrl = new Map<string, ApolloRawMatch>();
  for (const m of response.matches ?? []) {
    if (m.linkedin_url) matchesByUrl.set(normUrl(m.linkedin_url), m);
  }

  const results: EnrichmentResult[] = [];
  for (const batch of plan.batches) {
    for (const detail of batch.details) {
      const match = matchesByUrl.get(normUrl(detail.linkedin_url));
      if (!match) {
        results.push({ contactId: Number(detail.id), match: false });
        continue;
      }
      results.push({
        contactId: Number(detail.id),
        match: true,
        email: match.email ?? null,
        personId: match.id ?? null,
        confidence: match.email_status === 'verified' ? 1.0 : undefined,
      });
    }
  }
  return results;
}

function creditsConsumedFromLog(logFilePath: string): number {
  if (!fs.existsSync(logFilePath)) return 0;
  const content = fs.readFileSync(logFilePath, 'utf8');
  let total = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as EnrichmentLogEntry;
      total += entry.credits ?? 0;
    } catch {
      continue;
    }
  }
  return total;
}

function appendLog(logFilePath: string, entries: EnrichmentLogEntry[]): void {
  if (entries.length === 0) return;
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(logFilePath, body);
}

function selectEligible(
  contacts: MasterContact[],
  listId?: number,
): {
  eligible: MasterContact[];
  skippedByGate: Record<string, number>;
} {
  const skippedByGate: Record<string, number> = {
    'already-enriched': 0,
    'no-profile-url': 0,
    'missing-name-or-company': 0,
  };
  if (listId !== undefined) skippedByGate['not-in-list'] = 0;
  const eligible: MasterContact[] = [];

  for (const c of contacts) {
    if (listId !== undefined && c.gojiberryState?.listId !== listId) {
      skippedByGate['not-in-list']++;
      continue;
    }
    if (c.apolloEnrichedAt) {
      skippedByGate['already-enriched']++;
      continue;
    }
    if (!c.profileUrl) {
      skippedByGate['no-profile-url']++;
      continue;
    }
    if (!c.firstName || !c.company) {
      skippedByGate['missing-name-or-company']++;
      continue;
    }
    eligible.push(c);
  }

  eligible.sort((a, b) => (b.icpScore ?? 0) - (a.icpScore ?? 0));
  return { eligible, skippedByGate };
}

export async function planEnrichment(options: PlanOptions): Promise<EnrichmentPlan> {
  const contacts = await readMaster(options.masterFilePath);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const { eligible, skippedByGate } = selectEligible(contacts, options.listId);

  const warnings: string[] = [];
  const alreadyConsumed = creditsConsumedFromLog(options.logFilePath);
  const totalRemaining = Math.max(0, options.totalBudget - alreadyConsumed);
  if (totalRemaining === 0 && eligible.length > 0) warnings.push('total-budget-exhausted');

  const effectiveBudget = Math.min(options.runBudget, totalRemaining);
  let targetCount = Math.min(eligible.length, effectiveBudget);
  if (options.limit !== undefined) targetCount = Math.min(targetCount, options.limit);

  const selected = eligible.slice(0, targetCount);
  const runId = randomUUID();
  const batches: EnrichmentPlanBatch[] = [];
  for (let i = 0; i < selected.length; i += batchSize) {
    const slice = selected.slice(i, i + batchSize);
    batches.push({
      batchIndex: batches.length,
      details: slice.map((c) => ({
        id: String(c.id),
        linkedin_url: c.profileUrl,
        first_name: c.firstName,
        last_name: c.lastName,
        organization_name: c.company ?? '',
      })),
    });
  }

  return {
    runId,
    batches,
    eligible: eligible.length,
    projectedCredits: selected.length,
    creditsAlreadyUsed: alreadyConsumed,
    budgetRemaining: totalRemaining,
    skippedByGate,
    warnings,
    masterFilePath: options.masterFilePath,
    logFilePath: options.logFilePath,
  };
}

export async function applyEnrichmentResults(
  plan: EnrichmentPlan,
  results: EnrichmentResult[],
): Promise<EnrichResult> {
  const contacts = await readMaster(plan.masterFilePath);
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  const batchSizeByContactId = new Map<number, number>();
  for (const batch of plan.batches) {
    for (const d of batch.details) {
      batchSizeByContactId.set(Number(d.id), batch.details.length);
    }
  }

  const outcomes: Record<EnrichmentOutcome, number> = {
    success: 0,
    'no-email': 0,
    'no-match': 0,
    error: 0,
  };
  const logEntries: EnrichmentLogEntry[] = [];
  let enriched = 0;
  let creditsUsed = 0;

  for (const result of results) {
    const contact = contactById.get(result.contactId);
    if (!contact) continue;
    const batchSize = batchSizeByContactId.get(result.contactId) ?? 1;
    const now = new Date().toISOString();

    if (result.error) {
      outcomes.error++;
      logEntries.push({
        timestamp: now,
        runId: plan.runId,
        contactId: result.contactId,
        linkedinUrl: contact.profileUrl,
        credits: 0,
        outcome: 'error',
        error: result.error,
        batchSize,
      });
      continue;
    }

    contact.apolloEnrichedAt = now;
    contact.masterUpdatedAt = now;

    let outcome: EnrichmentOutcome;
    if (!result.match) {
      outcome = 'no-match';
    } else {
      contact.apolloPersonId = result.personId ?? null;
      if (result.email) {
        contact.email = result.email;
        contact.apolloMatchConfidence = result.confidence ?? null;
        outcome = 'success';
      } else {
        outcome = 'no-email';
      }
    }

    outcomes[outcome]++;
    enriched++;
    creditsUsed++;

    const entry: EnrichmentLogEntry = {
      timestamp: now,
      runId: plan.runId,
      contactId: result.contactId,
      linkedinUrl: contact.profileUrl,
      credits: 1,
      outcome,
      batchSize,
    };
    if (outcome === 'success' && result.email) entry.email = result.email;
    if (result.personId) entry.apolloPersonId = result.personId;
    logEntries.push(entry);
  }

  await writeMaster(plan.masterFilePath, contacts);
  appendLog(plan.logFilePath, logEntries);

  return {
    eligible: plan.eligible,
    projectedCredits: plan.projectedCredits,
    enriched,
    creditsUsed,
    skippedByGate: plan.skippedByGate,
    outcomes,
    warnings: plan.warnings,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Backward-compatible one-shot API (used by tests and by the CLI when an
// ApolloClient is available — e.g. in-process adapter)
// ──────────────────────────────────────────────────────────────────────────────

export async function enrichContacts(options: EnrichOptions): Promise<EnrichResult> {
  const plan = await planEnrichment(options);

  if (!options.apply || plan.batches.length === 0) {
    return {
      eligible: plan.eligible,
      projectedCredits: plan.projectedCredits,
      enriched: 0,
      creditsUsed: 0,
      skippedByGate: plan.skippedByGate,
      outcomes: { success: 0, 'no-email': 0, 'no-match': 0, error: 0 },
      warnings: plan.warnings,
    };
  }

  const results: EnrichmentResult[] = [];
  for (const batch of plan.batches) {
    const inputs: ApolloMatchInput[] = batch.details.map((d) => ({
      linkedinUrl: d.linkedin_url,
      firstName: d.first_name,
      lastName: d.last_name,
      company: d.organization_name,
    }));
    try {
      const mcpResults = await options._apollo.peopleBulkMatch(inputs);
      const byUrl = new Map(mcpResults.map((r) => [r.linkedinUrl, r]));
      for (const detail of batch.details) {
        const r = byUrl.get(detail.linkedin_url);
        if (!r) {
          results.push({ contactId: Number(detail.id), match: false, error: 'no-result-in-bulk-response' });
          continue;
        }
        results.push({
          contactId: Number(detail.id),
          match: r.match,
          email: r.email ?? null,
          personId: r.personId ?? null,
          confidence: r.confidence,
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      for (const detail of batch.details) {
        results.push({ contactId: Number(detail.id), match: false, error: errorMessage });
      }
    }
  }

  return applyEnrichmentResults(plan, results);
}
