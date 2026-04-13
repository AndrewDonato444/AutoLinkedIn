import { GojiBerryClient } from '../api/gojiberry-client.js';
import type { Lead } from '../api/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface IntentTypeMetrics {
  intentType: string;
  contactCount: number;
  averageFitScore: number | null;
  scoreTiers: {
    hot: number;
    warm: number;
    cool: number;
    cold: number;
    unscored: number;
  };
  signalQuality: 'high' | 'medium' | 'low' | 'needs_scoring';
}

export interface IntentTypeReport {
  generatedAt: string;
  totalContacts: number;
  totalTypes: number;
  types: IntentTypeMetrics[];
  topType: IntentTypeMetrics | null;
  bottomType: IntentTypeMetrics | null;
  reportText: string;
}

type IntentBreakdownClient = Pick<
  GojiBerryClient,
  'getIntentTypeCounts' | 'searchLeads' | 'getCampaigns'
>;

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

const FETCH_PAGE_SIZE = 250;
const TOP_N_DISPLAY = 10;

async function fetchAllLeads(client: IntentBreakdownClient): Promise<Lead[]> {
  const allLeads: Lead[] = [];
  let page = 1;
  let total = 0;

  do {
    const result = await client.searchLeads({ page, pageSize: FETCH_PAGE_SIZE });
    total = result.total;
    allLeads.push(...result.leads);
    page++;
  } while (allLeads.length < total);

  return allLeads;
}

function classifyScoreTier(score?: number): keyof IntentTypeMetrics['scoreTiers'] {
  if (score === undefined || score === null) return 'unscored';
  if (score >= 80) return 'hot';
  if (score >= 50) return 'warm';
  if (score >= 20) return 'cool';
  return 'cold';
}

function computeMetrics(intentType: string, leads: Lead[]): IntentTypeMetrics {
  const scoreTiers = { hot: 0, warm: 0, cool: 0, cold: 0, unscored: 0 };
  let scoreSum = 0;
  let scoredCount = 0;

  for (const lead of leads) {
    const tier = classifyScoreTier(lead.fitScore);
    scoreTiers[tier]++;
    if (lead.fitScore !== undefined && lead.fitScore !== null) {
      scoreSum += lead.fitScore;
      scoredCount++;
    }
  }

  const averageFitScore = scoredCount > 0 ? scoreSum / scoredCount : null;

  let signalQuality: IntentTypeMetrics['signalQuality'];
  if (averageFitScore === null) {
    signalQuality = 'needs_scoring';
  } else if (averageFitScore >= 60) {
    signalQuality = 'high';
  } else if (averageFitScore >= 30) {
    signalQuality = 'medium';
  } else {
    signalQuality = 'low';
  }

  return {
    intentType,
    contactCount: leads.length,
    averageFitScore,
    scoreTiers,
    signalQuality,
  };
}

function groupLeadsByIntentType(leads: Lead[]): Record<string, Lead[]> {
  const groups: Record<string, Lead[]> = {};
  for (const lead of leads) {
    const type = lead.intentType ?? 'unclassified';
    if (!groups[type]) groups[type] = [];
    groups[type].push(lead);
  }
  return groups;
}

function rankByFitScore(types: IntentTypeMetrics[]): IntentTypeMetrics[] {
  return [...types].sort((a, b) => {
    if (a.averageFitScore === null && b.averageFitScore === null) return 0;
    if (a.averageFitScore === null) return 1;
    if (b.averageFitScore === null) return -1;
    return b.averageFitScore - a.averageFitScore;
  });
}

function buildReportText(
  allTypes: IntentTypeMetrics[],
  comparableTypes: IntentTypeMetrics[],
  topType: IntentTypeMetrics | null,
  bottomType: IntentTypeMetrics | null,
  totalContacts: number,
): string {
  const lines: string[] = [];

  lines.push('=== Intent Type Breakdown ===');
  lines.push('');

  const nonUnclassified = allTypes.filter((t) => t.intentType !== 'unclassified');
  lines.push(
    `Pipeline: ${totalContacts} contacts across ${nonUnclassified.length} intent types`,
  );
  lines.push('');

  // Top intent types by contact count (show top N)
  const sortedByCount = [...allTypes].sort((a, b) => b.contactCount - a.contactCount);
  const topN = sortedByCount.slice(0, TOP_N_DISPLAY);
  const remaining = sortedByCount.slice(TOP_N_DISPLAY);

  lines.push(`--- Top Intent Types (by contact count) ---`);
  for (let i = 0; i < topN.length; i++) {
    const t = topN[i];
    const avgDisplay =
      t.averageFitScore !== null ? Math.round(t.averageFitScore).toString() : 'n/a';
    lines.push(
      `  ${i + 1}. ${t.intentType}: ${t.contactCount} contacts, avg score ${avgDisplay}, ` +
        `${t.scoreTiers.hot} hot / ${t.scoreTiers.warm} warm / ${t.scoreTiers.cool} cool`,
    );
  }

  if (remaining.length > 0) {
    const remainingContacts = remaining.reduce((sum, t) => sum + t.contactCount, 0);
    const typeWord = remaining.length === 1 ? 'type' : 'types';
    const contactWord = remainingContacts === 1 ? 'contact' : 'contacts';
    lines.push(
      `  and ${remaining.length} more ${typeWord} with ${remainingContacts} ${contactWord}`,
    );
  }

  lines.push('');

  // Signal quality section
  const byQuality = (q: IntentTypeMetrics['signalQuality']): string[] =>
    nonUnclassified.filter((t) => t.signalQuality === q).map((t) => t.intentType);
  const high = byQuality('high');
  const medium = byQuality('medium');
  const low = byQuality('low');
  const needsScoring = byQuality('needs_scoring');

  lines.push('--- Signal Quality ---');
  if (high.length > 0) lines.push(`  High signal: ${high.join(', ')}`);
  if (medium.length > 0) lines.push(`  Medium signal: ${medium.join(', ')}`);
  if (low.length > 0) lines.push(`  Low signal: ${low.join(', ')}`);
  if (needsScoring.length > 0) lines.push(`  Needs scoring: ${needsScoring.join(', ')}`);

  lines.push('');

  // Recommendation
  lines.push('--- Recommendation ---');
  if (comparableTypes.length <= 1) {
    lines.push(
      'Only one intent type in pipeline — consider diversifying discovery',
    );
  } else if (topType && bottomType) {
    const topAvg = topType.averageFitScore !== null ? Math.round(topType.averageFitScore) : 'n/a';
    lines.push(
      `Focus discovery on '${topType.intentType}' — highest average fit score (${topAvg}%).`,
    );
    lines.push(
      `Consider deprioritizing '${bottomType.intentType}' — lowest signal quality.`,
    );
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Fetches intent type data from GojiBerry, groups contacts by intent type,
 * and produces a structured breakdown report with signal quality analysis.
 *
 * Throws on API errors (auth, network) — the caller is responsible for retries.
 */
export async function analyzeIntentTypes(options?: {
  _client?: IntentBreakdownClient;
}): Promise<IntentTypeReport> {
  const client: IntentBreakdownClient = options?._client ?? new GojiBerryClient();

  const [intentTypeCounts, leads] = await Promise.all([
    client.getIntentTypeCounts(),
    fetchAllLeads(client),
    client.getCampaigns(), // fetched for future correlation; result not used yet
  ]);

  // Handle no intent data
  if (Object.keys(intentTypeCounts).length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      totalContacts: leads.length,
      totalTypes: 0,
      types: [],
      topType: null,
      bottomType: null,
      reportText:
        'No intent data available — enrich contacts with intent types first',
    };
  }

  // Group contacts by intent type (unclassified = no intentType)
  const groups = groupLeadsByIntentType(leads);

  // Compute metrics for each group
  const allTypes: IntentTypeMetrics[] = Object.entries(groups).map(([intentType, groupLeads]) =>
    computeMetrics(intentType, groupLeads),
  );

  // Comparable types exclude "unclassified" — used for ranking and recommendations
  const comparableTypes = allTypes.filter((t) => t.intentType !== 'unclassified');

  // Rank comparable types by average fit score (highest first; nulls last)
  const rankedTypes = rankByFitScore(comparableTypes);

  // Only set top/bottom when there are at least 2 comparable types
  const topType = rankedTypes.length > 1 ? rankedTypes[0] : null;
  const bottomType = rankedTypes.length > 1 ? rankedTypes[rankedTypes.length - 1] : null;

  const reportText = buildReportText(allTypes, comparableTypes, topType, bottomType, leads.length);

  // Sort types by contact count for the report (most contacts first)
  const sortedTypes = [...allTypes].sort((a, b) => b.contactCount - a.contactCount);

  return {
    generatedAt: new Date().toISOString(),
    totalContacts: leads.length,
    totalTypes: comparableTypes.length,
    types: sortedTypes,
    topType,
    bottomType,
    reportText,
  };
}
