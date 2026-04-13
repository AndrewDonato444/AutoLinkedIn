import dotenv from 'dotenv';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { GojiBerryClient } from '../api/gojiberry-client.js';
import { AuthError, ConfigError } from '../api/errors.js';
import type { Lead } from '../api/types.js';
import type { EnrichmentResult, IntentResearch, WebResearchFn } from './types.js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const DEFAULT_MIN_INTENT_SCORE = 50;
const DEFAULT_BATCH_SIZE = 25;
const ANTHROPIC_MODEL = 'claude-opus-4-6';
const WEB_RESEARCH_MAX_TOKENS = 8096;
const SUMMARY_SEPARATOR_WIDTH = 80;

type EnrichmentClient = Pick<GojiBerryClient, 'searchLeads' | 'getLead' | 'updateLead'>;

export interface EnrichLeadsOptions {
  leadId?: string;
  forceRefresh?: boolean;
  batchSize?: number;
  minIntentScore?: number;
  icpDescription?: string;
  /** Test-only: inject mock research function */
  _webResearch?: WebResearchFn;
  /** Test-only: inject mock GojiBerry client */
  _client?: EnrichmentClient;
}

export async function defaultWebResearch(
  lead: Lead,
  icpDescription: string,
): Promise<IntentResearch> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      'Missing ANTHROPIC_API_KEY in .env.local — required for web research',
    );
  }

  const anthropic = new Anthropic({ apiKey });

  const leadDescription = [
    `${lead.firstName} ${lead.lastName}`,
    lead.jobTitle ? `(${lead.jobTitle})` : '',
    lead.company ? `at ${lead.company}` : '',
    lead.profileUrl ? `— ${lead.profileUrl}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: WEB_RESEARCH_MAX_TOKENS,
    // web_search_20250305 is not in the SDK types yet — cast required
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: [{ type: 'web_search_20250305', name: 'web_search' }] as any,
    messages: [
      {
        role: 'user',
        content: `Research this lead and score them against the ICP.

Lead: ${leadDescription}
ICP: ${icpDescription}

1. Search for: recent LinkedIn posts, company news, job postings, funding announcements
2. Extract buying signals: hiring for relevant roles, raised funding, expanded to new market, relevant pain points
3. Score the lead 1-100 based on ICP fit AND intent signals

Return ONLY valid JSON (no other text):
{
  "fitScore": <integer 1-100>,
  "intentSignals": ["signal 1", "signal 2"],
  "reasoning": "brief explanation of the score"
}

If no online activity found, score based on profile data alone and return empty intentSignals array.`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return { fitScore: 1, intentSignals: [], reasoning: 'No research results available' };
  }

  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { fitScore: 1, intentSignals: [], reasoning: 'Could not parse research results' };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as IntentResearch;
    return {
      fitScore: Math.min(100, Math.max(1, Math.round(parsed.fitScore))),
      intentSignals: Array.isArray(parsed.intentSignals) ? parsed.intentSignals : [],
      reasoning: parsed.reasoning ?? '',
    };
  } catch {
    return { fitScore: 1, intentSignals: [], reasoning: 'Failed to parse research results' };
  }
}

function outputEnrichmentSummary(
  result: EnrichmentResult,
  minIntentScore: number,
): void {
  const { enriched, failed, skipped, remaining } = result;

  if (enriched.length === 0 && failed.length === 0 && skipped.length === 0) return;

  // Sort enriched leads: warm first (score >= threshold), then cold; within each group by score descending
  const warm = enriched
    .filter((e) => e.research.fitScore >= minIntentScore)
    .sort((a, b) => b.research.fitScore - a.research.fitScore);
  const cold = enriched
    .filter((e) => e.research.fitScore < minIntentScore)
    .sort((a, b) => b.research.fitScore - a.research.fitScore);
  const sorted = [...warm, ...cold];

  // Summary table
  if (sorted.length > 0) {
    console.log('\nEnrichment Summary:');
    console.log('─'.repeat(SUMMARY_SEPARATOR_WIDTH));
    for (const { lead, research } of sorted) {
      const status = research.fitScore >= minIntentScore ? 'warm' : 'cold';
      const topSignal = research.intentSignals[0] ?? '—';
      const parts: string[] = [
        `${lead.firstName} ${lead.lastName}`,
        lead.company ?? '—',
        `score: ${research.fitScore}`,
        topSignal,
        status,
      ];
      console.log(parts.join(' | '));
    }
    console.log('─'.repeat(SUMMARY_SEPARATOR_WIDTH));
  }

  // Totals line
  if (failed.length === 0 && skipped.length === 0 && remaining === 0) {
    console.log(
      `${enriched.length} leads enriched — ${warm.length} warm, ${cold.length} cold (threshold: ${minIntentScore})`,
    );
  } else if (remaining > 0 && failed.length === 0) {
    console.log(
      `${enriched.length} leads enriched (${remaining} remaining — run again to continue)`,
    );
    console.log(
      `${warm.length} warm, ${cold.length} cold (threshold: ${minIntentScore})`,
    );
  } else {
    const parts: string[] = [`${enriched.length} leads enriched`];
    if (failed.length > 0) parts.push(`${failed.length} failed (see logs)`);
    if (skipped.length > 0) parts.push(`${skipped.length} skipped`);
    console.log(parts.join(', '));
    if (enriched.length > 0) {
      console.log(
        `${warm.length} warm, ${cold.length} cold (threshold: ${minIntentScore})`,
      );
    }
    if (remaining > 0) {
      console.log(`${remaining} remaining — run again to continue`);
    }
  }
}

export async function enrichLeads(options: EnrichLeadsOptions = {}): Promise<EnrichmentResult> {
  const icpDescription = options.icpDescription ?? process.env.ICP_DESCRIPTION;

  if (!icpDescription || icpDescription.trim() === '') {
    throw new ConfigError(
      'Missing ICP_DESCRIPTION in .env.local — describe your ideal customer first',
    );
  }

  const rawMinScore =
    options.minIntentScore ?? Number(process.env.MIN_INTENT_SCORE ?? DEFAULT_MIN_INTENT_SCORE);
  const minIntentScore =
    Number.isFinite(rawMinScore) && rawMinScore > 0 ? rawMinScore : DEFAULT_MIN_INTENT_SCORE;

  const rawBatchSize =
    options.batchSize ?? Number(process.env.ENRICHMENT_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  const batchSize =
    Number.isFinite(rawBatchSize) && rawBatchSize > 0 ? rawBatchSize : DEFAULT_BATCH_SIZE;

  const client: EnrichmentClient = options._client ?? new GojiBerryClient();
  const webResearch: WebResearchFn = options._webResearch ?? defaultWebResearch;

  const result: EnrichmentResult = {
    enriched: [],
    failed: [],
    skipped: [],
    remaining: 0,
  };

  // ── Single-lead enrichment by ID ──────────────────────────────────────────
  if (options.leadId) {
    const lead = await client.getLead(options.leadId);
    const research = await webResearch(lead, icpDescription);

    await client.updateLead(lead.id, {
      fitScore: research.fitScore,
      intentSignals: research.intentSignals,
    });

    result.enriched.push({ lead, research });

    const signalList = research.intentSignals.length > 0
      ? research.intentSignals.join(', ')
      : 'none';
    console.log(
      `${lead.firstName} ${lead.lastName} — score: ${research.fitScore}, signals: ${signalList}`,
    );

    return result;
  }

  // ── Batch enrichment ──────────────────────────────────────────────────────
  const page = await client.searchLeads({ pageSize: batchSize });
  result.remaining = Math.max(0, page.total - page.leads.length);

  let leadsToProcess: Lead[];

  if (options.forceRefresh) {
    leadsToProcess = page.leads;
  } else {
    const unenriched = page.leads.filter(
      (l) => l.fitScore === null || l.fitScore === undefined,
    );
    const alreadyEnriched = page.leads.filter(
      (l) => l.fitScore !== null && l.fitScore !== undefined,
    );
    result.skipped.push(...alreadyEnriched);
    leadsToProcess = unenriched;
  }

  // Research and update each lead
  for (const lead of leadsToProcess) {
    try {
      const research = await webResearch(lead, icpDescription);

      if (research.intentSignals.length === 0) {
        console.log(
          `Low signal: ${lead.firstName} ${lead.lastName} — no buying signals found, scored on profile data only`,
        );
      }

      await client.updateLead(lead.id, {
        fitScore: research.fitScore,
        intentSignals: research.intentSignals,
      });

      result.enriched.push({ lead, research });
    } catch (err: unknown) {
      if (err instanceof AuthError) {
        console.error(err.message);
        throw err;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `Failed to update lead: ${lead.firstName} ${lead.lastName} — ${errorMessage}`,
      );
      result.failed.push({ lead, error: errorMessage });
    }
  }

  outputEnrichmentSummary(result, minIntentScore);

  return result;
}
