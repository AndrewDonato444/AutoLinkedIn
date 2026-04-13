import { GojiBerryClient } from '../api/gojiberry-client.js';
import type { Lead } from '../api/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface WarmLeadFilters {
  scoreFrom?: number;
  scoreTo?: number;
  dateFrom?: string;
  dateTo?: string;
  intentType?: string;
}

export interface WarmLead {
  id: string;
  firstName: string;
  lastName: string;
  company: string;
  jobTitle: string;
  profileUrl: string;
  fitScore: number;
  intentType: string;
  intentSignals: string[];
  scoreTier: 'hot' | 'warm';
  reasonForWarmth: string;
}

export interface WarmLeadListResult {
  leads: WarmLead[];
  filters: {
    scoreFrom: number;
    scoreTo: number;
    dateFrom?: string;
    dateTo?: string;
    intentType?: string;
  };
  byTier: {
    hot: WarmLead[];
    warm: WarmLead[];
  };
  total: number;
  reportText: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

const DEFAULT_MIN_SCORE = 50;
const DEFAULT_MAX_SCORE = 100;
const HOT_TIER_THRESHOLD = 80;
const FETCH_PAGE_SIZE = 250;

type WarmLeadClient = Pick<GojiBerryClient, 'searchLeads'>;

function getDefaultMinScore(): number {
  const env = process.env.MIN_INTENT_SCORE;
  if (env) {
    const parsed = Number(env);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return DEFAULT_MIN_SCORE;
}

function classifyTier(score: number): 'hot' | 'warm' {
  return score >= HOT_TIER_THRESHOLD ? 'hot' : 'warm';
}

function buildReasonForWarmth(score: number, signals: string[]): string {
  const tier = classifyTier(score);
  const tierLabel = tier === 'hot' ? 'Hot' : 'Warm';

  if (!signals || signals.length === 0) {
    return `${tierLabel} lead (score: ${score}) — No specific intent signals recorded — scored on ICP fit alone`;
  }

  return `${tierLabel} lead (score: ${score}) — ${signals.join(', ')}`;
}

function toWarmLead(lead: Lead): WarmLead {
  const score = lead.fitScore ?? 0;
  const signals = lead.intentSignals ?? [];
  return {
    id: lead.id,
    firstName: lead.firstName,
    lastName: lead.lastName,
    company: lead.company ?? '',
    jobTitle: lead.jobTitle ?? '',
    profileUrl: lead.profileUrl,
    fitScore: score,
    intentType: lead.intentType ?? '',
    intentSignals: signals,
    scoreTier: classifyTier(score),
    reasonForWarmth: buildReasonForWarmth(score, signals),
  };
}

async function fetchAllWarmLeads(
  client: WarmLeadClient,
  apiFilters: Record<string, unknown>,
): Promise<Lead[]> {
  const allLeads: Lead[] = [];
  let page = 1;
  let total = 0;

  do {
    const result = await client.searchLeads({ ...apiFilters, page, pageSize: FETCH_PAGE_SIZE } as Parameters<typeof client.searchLeads>[0]);
    total = result.total;
    allLeads.push(...result.leads);
    page++;
  } while (allLeads.length < total);

  return allLeads;
}

function formatLeadRow(lead: WarmLead, index: number): string[] {
  return [
    `  ${index + 1}. ${lead.firstName} ${lead.lastName} (${lead.company}) — Score: ${lead.fitScore}`,
    `     ${lead.jobTitle} | ${lead.intentType}`,
    `     Why warm: ${lead.reasonForWarmth}`,
  ];
}

function buildReportText(
  leads: WarmLead[],
  filters: WarmLeadListResult['filters'],
  byTier: WarmLeadListResult['byTier'],
): string {
  if (leads.length === 0) {
    return 'No warm leads found matching your criteria';
  }

  const lines: string[] = [];
  lines.push('=== Warm Lead List ===');
  lines.push('');

  const scorePart = filters.scoreTo !== DEFAULT_MAX_SCORE
    ? `score ${filters.scoreFrom}-${filters.scoreTo}`
    : `score >= ${filters.scoreFrom}`;
  const datePart = filters.dateFrom && filters.dateTo
    ? `${filters.dateFrom} to ${filters.dateTo}`
    : 'all dates';
  const intentPart = filters.intentType ? filters.intentType : 'all intent types';

  lines.push(`Filters: ${scorePart}, ${datePart}, ${intentPart}`);
  lines.push(`Found: ${leads.length} warm leads`);

  if (byTier.hot.length > 0) {
    lines.push('');
    lines.push(`--- Hot (80-100) — ${byTier.hot.length} leads ---`);
    byTier.hot.forEach((lead, i) => lines.push(...formatLeadRow(lead, i)));
  }

  if (byTier.warm.length > 0) {
    lines.push('');
    lines.push(`--- Warm (50-79) — ${byTier.warm.length} leads ---`);
    const offset = byTier.hot.length;
    byTier.warm.forEach((lead, i) => lines.push(...formatLeadRow(lead, offset + i)));
  }

  lines.push('');
  lines.push('No cool or cold leads included (below threshold).');

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Fetches warm leads from GojiBerry filtered by score, date, and intent type,
 * then returns a prioritized list sorted by fit score with a reason for warmth.
 *
 * Throws on API errors (auth, network) — the caller is responsible for retries.
 */
export async function buildWarmLeadList(
  filters?: WarmLeadFilters,
  options?: { _client?: WarmLeadClient },
): Promise<WarmLeadListResult> {
  const client: WarmLeadClient = options?._client ?? new GojiBerryClient();

  const minScore = filters?.scoreFrom ?? getDefaultMinScore();
  const maxScore = filters?.scoreTo ?? DEFAULT_MAX_SCORE;

  const apiFilters: Record<string, unknown> = {
    scoreFrom: minScore,
    scoreTo: maxScore,
  };
  if (filters?.dateFrom) apiFilters.dateFrom = filters.dateFrom;
  if (filters?.dateTo) apiFilters.dateTo = filters.dateTo;
  if (filters?.intentType) apiFilters.intentType = filters.intentType;

  const rawLeads = await fetchAllWarmLeads(client, apiFilters);

  // Convert and sort by fitScore descending
  const warmLeads = rawLeads
    .map(toWarmLead)
    .sort((a, b) => b.fitScore - a.fitScore);

  const byTier: WarmLeadListResult['byTier'] = {
    hot: warmLeads.filter((l) => l.scoreTier === 'hot'),
    warm: warmLeads.filter((l) => l.scoreTier === 'warm'),
  };

  const resolvedFilters: WarmLeadListResult['filters'] = {
    scoreFrom: minScore,
    scoreTo: maxScore,
    ...(filters?.dateFrom && { dateFrom: filters.dateFrom }),
    ...(filters?.dateTo && { dateTo: filters.dateTo }),
    ...(filters?.intentType && { intentType: filters.intentType }),
  };

  const reportText = buildReportText(warmLeads, resolvedFilters, byTier);

  return {
    leads: warmLeads,
    filters: resolvedFilters,
    byTier,
    total: warmLeads.length,
    reportText,
  };
}
