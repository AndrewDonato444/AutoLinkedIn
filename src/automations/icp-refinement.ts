import dotenv from 'dotenv';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { GojiBerryClient } from '../api/gojiberry-client.js';
import { ConfigError } from '../api/errors.js';
import type { Lead } from '../api/types.js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const DEFAULT_MIN_CAMPAIGNS = 2;

/** Traits from segments smaller than this are flagged low-confidence */
const MIN_SAMPLE_FOR_HIGH_CONFIDENCE = 10;

const ANTHROPIC_MODEL = 'claude-opus-4-6';
const ANALYSIS_MAX_TOKENS = 4096;

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface ContactSummary {
  id: string;
  firstName: string;
  lastName: string;
  company?: string;
  jobTitle?: string;
  location?: string;
  fitScore?: number;
  intentSignals?: string[];
  intentType?: string;
}

export interface IcpTrait {
  trait: string;
  replyRate: number;
  sampleSize: number;
  replied: number;
  category: 'working' | 'not_working' | 'inconclusive' | 'watch';
  confidence: 'high' | 'low';
}

export interface IcpRefinementSuggestion {
  type: 'add' | 'remove' | 'modify';
  trait: string;
  newTrait?: string;
  reason: string;
  confidence: 'high' | 'low';
}

export interface IcpRefinementReport {
  currentIcp: string;
  campaignCount: number;
  totalSent: number;
  totalReplied: number;
  overallReplyRate: number;
  traits: {
    working: IcpTrait[];
    notWorking: IcpTrait[];
    inconclusive: IcpTrait[];
    watch: IcpTrait[];
  };
  suggestions: IcpRefinementSuggestion[];
  proposedIcp: string | null;
  reportText: string;
}

type RefinementClient = Pick<GojiBerryClient, 'getCampaigns' | 'searchLeads'>;

export type ProfileAnalysisFn = (
  currentIcp: string,
  repliedLeads: ContactSummary[],
  nonRepliedLeads: ContactSummary[],
) => Promise<{
  traits: IcpTrait[];
  suggestions: IcpRefinementSuggestion[];
  proposedIcp: string;
}>;

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toContactSummary(lead: Lead): ContactSummary {
  return {
    id: lead.id,
    firstName: lead.firstName,
    lastName: lead.lastName,
    company: lead.company,
    jobTitle: lead.jobTitle,
    location: lead.location,
    fitScore: lead.fitScore,
    intentSignals: lead.intentSignals,
    intentType: lead.intentType,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Confidence + category enforcement
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Override confidence based on sample size. If a trait has fewer than
 * MIN_SAMPLE_FOR_HIGH_CONFIDENCE leads, it's low confidence regardless of
 * what the LLM returned. Working traits with low confidence are reclassified
 * to 'watch' (promising but not enough data).
 */
function applyConfidenceRules(traits: IcpTrait[]): IcpTrait[] {
  return traits.map((t) => {
    const lowSample = t.sampleSize < MIN_SAMPLE_FOR_HIGH_CONFIDENCE;
    const confidence: 'high' | 'low' = lowSample ? 'low' : t.confidence;
    // Working traits with low confidence move to 'watch'
    const category: IcpTrait['category'] =
      lowSample && t.category === 'working' ? 'watch' : t.category;
    return { ...t, confidence, category };
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Report text builder
// ──────────────────────────────────────────────────────────────────────────────

function buildReportText(
  currentIcp: string,
  campaignCount: number,
  totalSent: number,
  totalReplied: number,
  overallReplyRate: number,
  traits: IcpRefinementReport['traits'],
  suggestions: IcpRefinementSuggestion[],
  proposedIcp: string | null,
): string {
  const lines: string[] = [];

  lines.push('=== ICP Refinement Report ===');
  lines.push('');
  lines.push(`Current ICP: "${currentIcp}"`);
  lines.push('');
  lines.push(
    `Based on ${campaignCount} campaigns, ${totalReplied} replies out of ${totalSent} sent (${round2(overallReplyRate)}%)`,
  );

  // What's Working
  if (traits.working.length > 0) {
    lines.push('');
    lines.push("--- What's Working (keep these) ---");
    for (const t of traits.working) {
      lines.push(`  ${t.trait}: ${round2(t.replyRate)}% reply rate (${t.replied} replies)`);
    }
  }

  // What's Not Working
  if (traits.notWorking.length > 0) {
    lines.push('');
    lines.push("--- What's Not Working (consider dropping) ---");
    for (const t of traits.notWorking) {
      lines.push(
        `  ${t.trait}: ${round2(t.replyRate)}% reply rate (${t.sampleSize} sent, ${t.replied} replies)`,
      );
    }
  }

  // Inconclusive
  if (traits.inconclusive.length > 0) {
    lines.push('');
    lines.push('--- Inconclusive (not enough data) ---');
    for (const t of traits.inconclusive) {
      lines.push(
        `  ${t.trait}: ${round2(t.replyRate)}% reply rate — only ${t.sampleSize} leads contacted`,
      );
    }
  }

  // Signals to Watch
  if (traits.watch.length > 0) {
    lines.push('');
    lines.push('--- Signals to Watch ---');
    for (const t of traits.watch) {
      lines.push(
        `  ${t.trait}: promising at ${round2(t.replyRate)}% but small sample (${t.sampleSize} leads)`,
      );
    }
  }

  // Suggested ICP Update
  const highConfSuggestions = suggestions.filter((s) => s.confidence === 'high');
  if (proposedIcp && highConfSuggestions.length > 0) {
    lines.push('');
    lines.push('--- Suggested ICP Update ---');
    lines.push('');
    lines.push(`Current:  "${currentIcp}"`);
    lines.push(`Proposed: "${proposedIcp}"`);
    lines.push('');
    lines.push('Changes:');
    for (const s of highConfSuggestions) {
      if (s.type === 'add') {
        lines.push(`  + Added: ${s.trait} — ${s.reason}`);
      } else if (s.type === 'remove') {
        lines.push(`  - Removed: ${s.trait} — ${s.reason}`);
      } else if (s.type === 'modify') {
        lines.push(`  ~ Modified: ${s.trait} → ${s.newTrait ?? ''} — ${s.reason}`);
      }
    }
    lines.push('');
    lines.push('To apply: update ICP_DESCRIPTION in .env.local');
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Real Anthropic profile analysis
// ──────────────────────────────────────────────────────────────────────────────

export async function defaultAnalyzeProfiles(
  currentIcp: string,
  repliedLeads: ContactSummary[],
  nonRepliedLeads: ContactSummary[],
): Promise<{
  traits: IcpTrait[];
  suggestions: IcpRefinementSuggestion[];
  proposedIcp: string;
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      'Missing ANTHROPIC_API_KEY in .env.local — required for ICP profile analysis',
    );
  }

  const anthropic = new Anthropic({ apiKey });

  const prompt = `You are analyzing sales campaign data to refine an Ideal Customer Profile (ICP).

Current ICP: "${currentIcp}"

Leads who REPLIED (${repliedLeads.length} total):
${JSON.stringify(repliedLeads, null, 2)}

Leads who did NOT reply (${nonRepliedLeads.length} total):
${JSON.stringify(nonRepliedLeads, null, 2)}

Analyze the profiles and identify patterns:
- Traits that correlate with replies (category: "working")
- Traits that correlate with non-replies (category: "not_working")
- Traits present equally in both groups with no clear signal (category: "inconclusive")
- Traits that look promising but have too few data points (category: "watch")

For each trait, compute:
- replyRate: percentage of leads with this trait who replied (0-100)
- sampleSize: total leads with this trait
- replied: count of leads with this trait who replied
- confidence: "high" if sampleSize >= 10, "low" if sampleSize < 10

Return ONLY a valid JSON object with this exact structure (no other text):
{
  "traits": [
    {
      "trait": "string description",
      "replyRate": 0,
      "sampleSize": 0,
      "replied": 0,
      "category": "working",
      "confidence": "high"
    }
  ],
  "suggestions": [
    {
      "type": "add",
      "trait": "string",
      "newTrait": "string (only for modify type)",
      "reason": "data-backed explanation with numbers",
      "confidence": "high"
    }
  ],
  "proposedIcp": "revised ICP description incorporating winning patterns"
}`;

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: ANALYSIS_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return { traits: [], suggestions: [], proposedIcp: currentIcp };
  }

  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { traits: [], suggestions: [], proposedIcp: currentIcp };
  }

  try {
    return JSON.parse(jsonMatch[0]) as {
      traits: IcpTrait[];
      suggestions: IcpRefinementSuggestion[];
      proposedIcp: string;
    };
  } catch {
    return { traits: [], suggestions: [], proposedIcp: currentIcp };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────────────────────────────────────

export async function refineIcp(options?: {
  icpDescription?: string;
  minCampaigns?: number;
  /** Injectable for testing — bypasses real Anthropic analysis */
  _analyzeProfiles?: ProfileAnalysisFn;
  /** Injectable for testing — bypasses real GojiBerry client */
  _client?: RefinementClient;
}): Promise<IcpRefinementReport> {
  // Step 1: Validate ICP description
  const icpDescription = options?.icpDescription ?? process.env.ICP_DESCRIPTION;
  if (!icpDescription || icpDescription.trim() === '') {
    throw new ConfigError(
      'Missing ICP_DESCRIPTION in .env.local — set your ideal customer description first',
    );
  }

  const minCampaigns =
    options?.minCampaigns ??
    Number(process.env.MIN_CAMPAIGNS_FOR_REFINEMENT ?? DEFAULT_MIN_CAMPAIGNS);

  const client: RefinementClient = options?._client ?? new GojiBerryClient();
  const analyzeProfiles: ProfileAnalysisFn =
    options?._analyzeProfiles ?? defaultAnalyzeProfiles;

  // Step 2: Fetch campaigns — AuthError propagates (intentional)
  const campaigns = await client.getCampaigns();
  const completedCampaigns = campaigns.filter((c) => c.status === 'completed');

  // Step 3: Gate — minimum completed campaigns
  if (completedCampaigns.length < minCampaigns) {
    const message =
      `Not enough campaign data yet — need at least ${minCampaigns} completed campaigns ` +
      `with replies to suggest ICP refinements. You have ${completedCampaigns.length}.`;
    return {
      currentIcp: icpDescription,
      campaignCount: completedCampaigns.length,
      totalSent: 0,
      totalReplied: 0,
      overallReplyRate: 0,
      traits: { working: [], notWorking: [], inconclusive: [], watch: [] },
      suggestions: [],
      proposedIcp: null,
      reportText: message,
    };
  }

  // Step 4: Compute aggregate stats from campaign metrics
  const totalSent = completedCampaigns.reduce(
    (sum, c) => sum + (c.metrics?.sent ?? 0),
    0,
  );
  const totalReplied = completedCampaigns.reduce(
    (sum, c) => sum + (c.metrics?.replied ?? 0),
    0,
  );

  // Step 5: Gate — zero replies
  if (totalReplied === 0) {
    const message =
      `No replies yet across ${completedCampaigns.length} campaigns — can't refine what ` +
      `hasn't been validated. Focus on improving messages first (see /build-next for message style optimization).`;
    return {
      currentIcp: icpDescription,
      campaignCount: completedCampaigns.length,
      totalSent,
      totalReplied: 0,
      overallReplyRate: 0,
      traits: { working: [], notWorking: [], inconclusive: [], watch: [] },
      suggestions: [],
      proposedIcp: null,
      reportText: message,
    };
  }

  // Step 6: Fetch lead profiles for analysis
  const [repliedResult, allLeadsResult] = await Promise.all([
    client.searchLeads({ intentType: 'replied' }),
    client.searchLeads(),
  ]);

  // Non-replied = all leads minus replied leads
  const repliedIds = new Set(repliedResult.leads.map((l) => l.id));
  const nonRepliedLeads = allLeadsResult.leads.filter((l) => !repliedIds.has(l.id));

  const repliedSummaries = repliedResult.leads.map(toContactSummary);
  const nonRepliedSummaries = nonRepliedLeads.map(toContactSummary);

  // Step 7: Delegate profile analysis to Claude (or injected fn for tests)
  const analysis = await analyzeProfiles(icpDescription, repliedSummaries, nonRepliedSummaries);

  // Step 8: Apply confidence rules (sample size override)
  const processedTraits = applyConfidenceRules(analysis.traits);

  const traits = {
    working: processedTraits.filter((t) => t.category === 'working'),
    notWorking: processedTraits.filter((t) => t.category === 'not_working'),
    inconclusive: processedTraits.filter((t) => t.category === 'inconclusive'),
    watch: processedTraits.filter((t) => t.category === 'watch'),
  };

  // Only show proposed ICP when there are high-confidence suggestions
  const highConfSuggestions = analysis.suggestions.filter((s) => s.confidence === 'high');
  const proposedIcp = highConfSuggestions.length > 0 ? analysis.proposedIcp : null;

  const overallReplyRate = totalSent > 0 ? (totalReplied / totalSent) * 100 : 0;

  // Step 9: Build report text
  const reportText = buildReportText(
    icpDescription,
    completedCampaigns.length,
    totalSent,
    totalReplied,
    overallReplyRate,
    traits,
    analysis.suggestions,
    proposedIcp,
  );

  return {
    currentIcp: icpDescription,
    campaignCount: completedCampaigns.length,
    totalSent,
    totalReplied,
    overallReplyRate,
    traits,
    suggestions: analysis.suggestions,
    proposedIcp,
    reportText,
  };
}
