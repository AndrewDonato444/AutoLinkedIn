import dotenv from 'dotenv';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { GojiBerryClient } from '../api/gojiberry-client.js';
import { ConfigError } from '../api/errors.js';
import type { Campaign, Lead, LeadFilters } from '../api/types.js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const DEFAULT_MIN_CAMPAIGNS = 3;
const DEFAULT_MIN_LEADS = 30;
const MIN_SAMPLE_HIGH_CONF = 10;
const MIN_CAMPAIGNS_FOR_TREND = 6;
const WARM_THRESHOLD = 50;
const PAGE_SIZE = 100;
const ANTHROPIC_MODEL = 'claude-opus-4-6';
const ANALYSIS_MAX_TOKENS = 4096;

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface IntentTypeCorrelation {
  intentType: string;
  sent: number;
  replied: number;
  replyRate: number;
  confidence: 'high' | 'low';
}

export interface SignalEffectiveness {
  signal: string;
  leadsWithSignal: number;
  repliedWithSignal: number;
  replyRateWithSignal: number;
  baselineReplyRate: number;
  lift: number;
  category: 'effective' | 'ineffective' | 'inconclusive';
  confidence: 'high' | 'low';
}

export interface PipelineFunnel {
  discovered: number;
  enriched: number;
  warm: number;
  campaigned: number;
  replied: number;
  biggestLeak: {
    stage: string;
    conversionRate: number;
  };
}

export interface ScoringHealth {
  status: 'predictive' | 'drifted' | 'insufficient_data';
  highScoreReplyRate: number;
  lowScoreReplyRate: number;
  explanation: string;
}

export interface FeedbackRecommendation {
  recommendation: string;
  type: 'weight_increase' | 'weight_decrease' | 'recalibrate' | 'focus_area';
  confidence: 'high' | 'low';
  dataPoint: string;
}

export interface LeadQualityFeedbackReport {
  campaignCount: number;
  totalLeads: number;
  totalReplied: number;
  overallReplyRate: number;
  noReplies: boolean;
  funnel: PipelineFunnel;
  intentCorrelations: IntentTypeCorrelation[];
  signalEffectiveness: {
    effective: SignalEffectiveness[];
    ineffective: SignalEffectiveness[];
    inconclusive: SignalEffectiveness[];
  };
  scoringHealth: ScoringHealth;
  trend: {
    direction: 'improving' | 'declining' | 'stable' | 'insufficient_data';
    earlyReplyRate: number;
    recentReplyRate: number;
    earlyCampaignCount: number;
    recentCampaignCount: number;
  };
  recommendations: FeedbackRecommendation[];
  reportText: string;
}

type FeedbackClient = Pick<GojiBerryClient, 'getCampaigns' | 'searchLeads' | 'getIntentTypeCounts'>;

export type PatternAnalysisFn = (
  repliedLeads: Lead[],
  nonRepliedLeads: Lead[],
  allLeads: Lead[],
  campaigns: Campaign[],
) => Promise<{
  signalEffectiveness: SignalEffectiveness[];
  recommendations: FeedbackRecommendation[];
}>;

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function computeMedian(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function campaignReplyRate(c: Campaign): number {
  const sent = c.metrics?.sent ?? 0;
  const replied = c.metrics?.replied ?? 0;
  return sent > 0 ? (replied / sent) * 100 : 0;
}

async function fetchAllLeads(
  client: FeedbackClient,
  filters: Omit<LeadFilters, 'page' | 'pageSize'> = {},
): Promise<Lead[]> {
  const allLeads: Lead[] = [];
  let page = 1;

  while (true) {
    const result = await client.searchLeads({ ...filters, page, pageSize: PAGE_SIZE });
    allLeads.push(...result.leads);
    if (allLeads.length >= result.total || result.leads.length < PAGE_SIZE) break;
    page++;
  }

  return allLeads;
}

// ──────────────────────────────────────────────────────────────────────────────
// Intent type correlation
// ──────────────────────────────────────────────────────────────────────────────

function computeIntentTypeCorrelations(
  allLeads: Lead[],
  repliedIds: Set<string>,
): IntentTypeCorrelation[] {
  const groups = new Map<string, Lead[]>();

  for (const lead of allLeads) {
    const type = lead.intentType;
    if (!type || type === 'replied') continue;
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type)!.push(lead);
  }

  const correlations: IntentTypeCorrelation[] = [];

  for (const [intentType, leads] of groups) {
    const sent = leads.length;
    const replied = leads.filter((l) => repliedIds.has(l.id)).length;
    const replyRate = sent > 0 ? (replied / sent) * 100 : 0;
    const confidence: 'high' | 'low' = sent >= MIN_SAMPLE_HIGH_CONF ? 'high' : 'low';

    correlations.push({
      intentType,
      sent,
      replied,
      replyRate: round2(replyRate),
      confidence,
    });
  }

  return correlations.sort((a, b) => b.replyRate - a.replyRate);
}

// ──────────────────────────────────────────────────────────────────────────────
// Pipeline funnel
// ──────────────────────────────────────────────────────────────────────────────

function computePipelineFunnel(
  allLeads: Lead[],
  repliedLeads: Lead[],
  campaigns: Campaign[],
): PipelineFunnel {
  const discovered = allLeads.length;
  const enriched = allLeads.filter(
    (l) => (l.intentSignals?.length ?? 0) > 0 || l.fitScore !== undefined,
  ).length;
  const warm = allLeads.filter((l) => (l.fitScore ?? 0) >= WARM_THRESHOLD).length;
  const campaigned = campaigns.reduce((sum, c) => sum + (c.metrics?.sent ?? 0), 0);
  const replied = repliedLeads.length;

  // Conversion rates at each stage
  const stages: Array<{ name: string; rate: number }> = [
    {
      name: 'discovered → enriched',
      rate: discovered > 0 ? enriched / discovered : 0,
    },
    {
      name: 'enriched → warm',
      rate: enriched > 0 ? warm / enriched : 0,
    },
    {
      name: 'warm → campaigned',
      rate: warm > 0 ? Math.min(campaigned, warm) / warm : 0,
    },
    {
      name: 'campaigned → replied',
      rate: campaigned > 0 ? replied / campaigned : 0,
    },
  ];

  const biggestLeak = stages.reduce((min, s) => (s.rate < min.rate ? s : min), stages[0]);

  return {
    discovered,
    enriched,
    warm,
    campaigned,
    replied,
    biggestLeak: {
      stage: biggestLeak.name,
      conversionRate: round2(biggestLeak.rate),
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Scoring health
// ──────────────────────────────────────────────────────────────────────────────

function computeScoringHealth(allLeads: Lead[], repliedIds: Set<string>): ScoringHealth {
  const scoredLeads = allLeads.filter((l) => l.fitScore !== undefined);

  if (scoredLeads.length < MIN_SAMPLE_HIGH_CONF) {
    return {
      status: 'insufficient_data',
      highScoreReplyRate: 0,
      lowScoreReplyRate: 0,
      explanation: 'Not enough leads with fit scores to evaluate scoring health',
    };
  }

  const scores = scoredLeads.map((l) => l.fitScore!).sort((a, b) => a - b);
  const median = computeMedian(scores);

  const highScore = scoredLeads.filter((l) => l.fitScore! >= median);
  const lowScore = scoredLeads.filter((l) => l.fitScore! < median);

  if (highScore.length < 5 || lowScore.length < 5) {
    return {
      status: 'insufficient_data',
      highScoreReplyRate: 0,
      lowScoreReplyRate: 0,
      explanation: 'Not enough leads in each score group to compare',
    };
  }

  const highReplied = highScore.filter((l) => repliedIds.has(l.id)).length;
  const lowReplied = lowScore.filter((l) => repliedIds.has(l.id)).length;

  const highReplyRate = round2((highReplied / highScore.length) * 100);
  const lowReplyRate = round2((lowReplied / lowScore.length) * 100);

  // Predictive if high-score leads reply at 1.5x+ rate of low-score
  const ratio = lowReplyRate > 0 ? highReplyRate / lowReplyRate : highReplyRate > 0 ? Infinity : 1;

  if (ratio >= 1.5) {
    return {
      status: 'predictive',
      highScoreReplyRate: highReplyRate,
      lowScoreReplyRate: lowReplyRate,
      explanation: `Scoring is still predictive — high-score leads reply at ${round2(ratio)}x the rate of low-score`,
    };
  }

  return {
    status: 'drifted',
    highScoreReplyRate: highReplyRate,
    lowScoreReplyRate: lowReplyRate,
    explanation:
      `Scoring drift detected — high-score leads replied at ${highReplyRate}% vs ${lowReplyRate}% ` +
      `for low-score in recent campaigns. Scoring criteria may need recalibration.`,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Trend
// ──────────────────────────────────────────────────────────────────────────────

function computeFeedbackTrend(campaigns: Campaign[]): LeadQualityFeedbackReport['trend'] {
  const completedWithSends = campaigns
    .filter((c) => c.status === 'completed' && (c.metrics?.sent ?? 0) > 0)
    .sort((a, b) => (a.createdAt ?? a.id).localeCompare(b.createdAt ?? b.id));

  if (completedWithSends.length < MIN_CAMPAIGNS_FOR_TREND) {
    return {
      direction: 'insufficient_data',
      earlyReplyRate: 0,
      recentReplyRate: 0,
      earlyCampaignCount: 0,
      recentCampaignCount: 0,
    };
  }

  const mid = Math.floor(completedWithSends.length / 2);
  const early = completedWithSends.slice(0, mid);
  const recent = completedWithSends.slice(mid);

  const earlyReplyRate = round2(
    early.reduce((sum, c) => sum + campaignReplyRate(c), 0) / early.length,
  );
  const recentReplyRate = round2(
    recent.reduce((sum, c) => sum + campaignReplyRate(c), 0) / recent.length,
  );

  const diff = recentReplyRate - earlyReplyRate;
  const direction: LeadQualityFeedbackReport['trend']['direction'] =
    diff > 1 ? 'improving' : diff < -1 ? 'declining' : 'stable';

  return {
    direction,
    earlyReplyRate,
    recentReplyRate,
    earlyCampaignCount: early.length,
    recentCampaignCount: recent.length,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Field importance (deterministic)
// ──────────────────────────────────────────────────────────────────────────────

function computeFieldImportance(
  allLeads: Lead[],
  repliedIds: Set<string>,
  overallReplyRate: number,
): SignalEffectiveness[] {
  const checks: Array<{ signal: string; hasFn: (l: Lead) => boolean }> = [
    { signal: 'intentSignals present', hasFn: (l) => (l.intentSignals?.length ?? 0) > 0 },
    { signal: 'company populated', hasFn: (l) => !!l.company },
    { signal: 'jobTitle populated', hasFn: (l) => !!l.jobTitle },
  ];

  const results: SignalEffectiveness[] = [];

  for (const { signal, hasFn } of checks) {
    const withSignal = allLeads.filter(hasFn);
    const leadsWithSignal = withSignal.length;
    if (leadsWithSignal === 0) continue;

    const repliedWithSignal = withSignal.filter((l) => repliedIds.has(l.id)).length;
    const replyRateWithSignal = round2((repliedWithSignal / leadsWithSignal) * 100);
    const lift = overallReplyRate > 0 ? round2(replyRateWithSignal / overallReplyRate) : 0;
    const confidence: 'high' | 'low' = leadsWithSignal >= MIN_SAMPLE_HIGH_CONF ? 'high' : 'low';

    let category: SignalEffectiveness['category'];
    if (leadsWithSignal < MIN_SAMPLE_HIGH_CONF) {
      category = 'inconclusive';
    } else if (lift >= 1.5) {
      category = 'effective';
    } else if (lift < 0.8) {
      category = 'ineffective';
    } else {
      category = 'inconclusive';
    }

    results.push({
      signal,
      leadsWithSignal,
      repliedWithSignal,
      replyRateWithSignal,
      baselineReplyRate: round2(overallReplyRate),
      lift,
      category,
      confidence,
    });
  }

  // FitScore median split as field importance
  const scoredLeads = allLeads.filter((l) => l.fitScore !== undefined);
  if (scoredLeads.length >= MIN_SAMPLE_HIGH_CONF) {
    const sortedScores = scoredLeads.map((l) => l.fitScore!).sort((a, b) => a - b);
    const median = computeMedian(sortedScores);
    const aboveMedian = scoredLeads.filter((l) => l.fitScore! >= median);
    const repliedAboveMedian = aboveMedian.filter((l) => repliedIds.has(l.id)).length;
    const aboveRate = round2(
      aboveMedian.length > 0 ? (repliedAboveMedian / aboveMedian.length) * 100 : 0,
    );
    const scoreLift = overallReplyRate > 0 ? round2(aboveRate / overallReplyRate) : 0;

    results.push({
      signal: 'fitScore above median',
      leadsWithSignal: aboveMedian.length,
      repliedWithSignal: repliedAboveMedian,
      replyRateWithSignal: aboveRate,
      baselineReplyRate: round2(overallReplyRate),
      lift: scoreLift,
      category: scoreLift >= 1.5 ? 'effective' : scoreLift < 0.8 ? 'ineffective' : 'inconclusive',
      confidence: 'high',
    });
  }

  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// Report text builder
// ──────────────────────────────────────────────────────────────────────────────

function buildReportText(
  report: Omit<LeadQualityFeedbackReport, 'reportText'>,
): string {
  const lines: string[] = [];

  lines.push('=== Lead Quality Feedback Report ===');
  lines.push('');
  lines.push(
    `Based on ${report.campaignCount} campaigns, ${report.totalLeads} leads through the pipeline, ` +
      `${report.totalReplied} replies (${round2(report.overallReplyRate)}%)`,
  );

  // --- Pipeline Funnel ---
  const f = report.funnel;
  lines.push('');
  lines.push('--- Pipeline Funnel ---');
  lines.push(`  Discovered:  ${f.discovered}`);
  if (f.discovered > 0) {
    lines.push(`  Enriched:    ${f.enriched} (${round2((f.enriched / f.discovered) * 100)}% of discovered)`);
  }
  if (f.enriched > 0) {
    lines.push(`  Warm:        ${f.warm} (${round2((f.warm / f.enriched) * 100)}% of enriched)`);
  }
  if (f.warm > 0) {
    const warmToCampaigned = Math.min(f.campaigned, f.warm);
    lines.push(`  Campaigned:  ${f.campaigned} (${round2((warmToCampaigned / f.warm) * 100)}% of warm)`);
  }
  if (f.campaigned > 0) {
    lines.push(`  Replied:     ${f.replied} (${round2((f.replied / f.campaigned) * 100)}% of campaigned)`);
  }
  if (f.biggestLeak.stage) {
    lines.push(
      `  Biggest leak: ${f.biggestLeak.stage} (${round2(f.biggestLeak.conversionRate * 100)}%)`,
    );
  }

  // --- Intent Types That Predict Replies ---
  lines.push('');
  lines.push('--- Intent Types That Predict Replies ---');
  if (report.intentCorrelations.length === 0) {
    lines.push('  No intent type data available');
  } else {
    const withReplies = report.intentCorrelations.filter((c) => c.replied > 0);
    const noReplies = report.intentCorrelations.filter((c) => c.replied === 0);

    for (const c of withReplies) {
      lines.push(
        `  ${c.intentType}: ${round2(c.replyRate)}% reply rate (${c.sent} sent, ${c.replied} replied) — ${c.confidence} confidence`,
      );
    }
    if (noReplies.length > 0) {
      lines.push(`  No signal: ${noReplies.map((c) => c.intentType).join(', ')}`);
    }
  }

  // --- Enrichment Signals That Work ---
  const allSignals = [
    ...report.signalEffectiveness.effective,
    ...report.signalEffectiveness.ineffective,
    ...report.signalEffectiveness.inconclusive,
  ];
  const effectiveSignals = allSignals.filter((s) => s.category === 'effective');
  const ineffectiveSignals = allSignals.filter((s) => s.category === 'ineffective');

  lines.push('');
  lines.push('--- Enrichment Signals That Work ---');
  if (effectiveSignals.length === 0) {
    lines.push('  No high-signal enrichment patterns found yet');
  } else {
    for (const s of effectiveSignals) {
      lines.push(
        `  "${s.signal}": ${round2(s.replyRateWithSignal)}% reply rate vs. ${round2(s.baselineReplyRate)}% overall — ${round2(s.lift)}x lift`,
      );
    }
  }

  lines.push('');
  lines.push('--- Enrichment Signals That Don\'t Work ---');
  if (ineffectiveSignals.length === 0) {
    lines.push('  No confirmed low-signal enrichment patterns found');
  } else {
    for (const s of ineffectiveSignals) {
      lines.push(
        `  "${s.signal}": ${round2(s.replyRateWithSignal)}% reply rate vs. ${round2(s.baselineReplyRate)}% overall — no lift`,
      );
    }
  }

  // --- Scoring Health ---
  lines.push('');
  lines.push('--- Scoring Health ---');
  const sh = report.scoringHealth;
  if (sh.status === 'insufficient_data') {
    lines.push(`  Insufficient data: ${sh.explanation}`);
  } else {
    lines.push(`  ${sh.status === 'predictive' ? 'Predictive' : 'Drift detected'}: ${sh.explanation}`);
  }

  // --- Trend ---
  const t = report.trend;
  lines.push('');
  lines.push('--- Trend ---');
  if (t.direction === 'insufficient_data') {
    lines.push('  Trend: insufficient data (need 6+ completed campaigns)');
  } else {
    lines.push(
      `  Early campaigns (${t.earlyCampaignCount}): ${round2(t.earlyReplyRate)}% reply rate`,
    );
    lines.push(
      `  Recent campaigns (${t.recentCampaignCount}): ${round2(t.recentReplyRate)}% reply rate`,
    );
    const trendLabel =
      t.direction === 'improving'
        ? 'Your pipeline is getting smarter'
        : t.direction === 'declining'
          ? 'Reply rate is declining — review recent changes'
          : 'Pipeline performance is stable';
    lines.push(`  Trend: ${t.direction} — ${trendLabel}`);
  }

  // --- Recommendations ---
  const highConfRecs = report.recommendations.filter((r) => r.confidence === 'high');
  const lowConfRecs = report.recommendations.filter((r) => r.confidence === 'low');

  lines.push('');
  lines.push('--- Recommendations ---');
  if (highConfRecs.length === 0) {
    lines.push('  No high-confidence recommendations yet — need more campaign data');
  } else {
    highConfRecs.forEach((rec, i) => {
      lines.push(`  ${i + 1}. ${rec.recommendation} — ${rec.confidence} confidence`);
    });
  }

  // --- Signals to Watch (low confidence) ---
  const lowConfIntents = report.intentCorrelations.filter((c) => c.confidence === 'low');
  const allLowConf = [
    ...lowConfRecs,
    ...lowConfIntents.map((c) => ({
      recommendation: `${c.intentType}: ${round2(c.replyRate)}% reply rate`,
      dataPoint: `small sample (${c.sent} leads)`,
    })),
  ];

  if (allLowConf.length > 0) {
    lines.push('');
    lines.push('--- Signals to Watch (low confidence) ---');
    for (const item of allLowConf) {
      const dataPoint = 'dataPoint' in item ? item.dataPoint : '';
      lines.push(
        `  ${'recommendation' in item ? item.recommendation : ''} — need more data to confirm${dataPoint ? ` (${dataPoint})` : ''}`,
      );
    }
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Empty report factory
// ──────────────────────────────────────────────────────────────────────────────

function makeEmptyReport(
  campaignCount: number,
  totalLeads: number,
  totalReplied: number,
  reportText: string,
  noReplies = false,
): LeadQualityFeedbackReport {
  return {
    campaignCount,
    totalLeads,
    totalReplied,
    overallReplyRate: 0,
    noReplies,
    funnel: {
      discovered: totalLeads,
      enriched: 0,
      warm: 0,
      campaigned: 0,
      replied: 0,
      biggestLeak: { stage: '', conversionRate: 0 },
    },
    intentCorrelations: [],
    signalEffectiveness: { effective: [], ineffective: [], inconclusive: [] },
    scoringHealth: {
      status: 'insufficient_data',
      highScoreReplyRate: 0,
      lowScoreReplyRate: 0,
      explanation: '',
    },
    trend: {
      direction: 'insufficient_data',
      earlyReplyRate: 0,
      recentReplyRate: 0,
      earlyCampaignCount: 0,
      recentCampaignCount: 0,
    },
    recommendations: [],
    reportText,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Real Anthropic pattern analysis
// ──────────────────────────────────────────────────────────────────────────────

export async function defaultAnalyzePatterns(
  repliedLeads: Lead[],
  nonRepliedLeads: Lead[],
  _allLeads: Lead[],
  _campaigns: Campaign[],
): Promise<{
  signalEffectiveness: SignalEffectiveness[];
  recommendations: FeedbackRecommendation[];
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      'Missing ANTHROPIC_API_KEY in .env.local — needed for pattern analysis',
    );
  }

  const anthropic = new Anthropic({ apiKey });

  const prompt = `You are analyzing sales lead data to identify which enrichment signals predict replies.

Leads who REPLIED (${repliedLeads.length} total):
${JSON.stringify(
  repliedLeads.map((l) => ({
    intentSignals: l.intentSignals,
    company: l.company,
    jobTitle: l.jobTitle,
    fitScore: l.fitScore,
  })),
  null,
  2,
)}

Leads who did NOT reply (${nonRepliedLeads.length} total):
${JSON.stringify(
  nonRepliedLeads.map((l) => ({
    intentSignals: l.intentSignals,
    company: l.company,
    jobTitle: l.jobTitle,
    fitScore: l.fitScore,
  })),
  null,
  2,
)}

Analyze the intentSignals arrays (free-text buying signals) and identify:
1. Which signal themes correlate with replies (effective signals)
2. Which signal themes do NOT predict replies (ineffective signals)
3. Recommended scoring weight changes based on the patterns

For each signal, estimate:
- leadsWithSignal: approximate count of leads with this signal theme
- repliedWithSignal: how many of those replied
- replyRateWithSignal: percentage that replied
- baselineReplyRate: overall reply rate across all leads
- lift: replyRateWithSignal / baselineReplyRate
- category: "effective" if lift >= 1.5, "ineffective" if lift < 0.8, else "inconclusive"
- confidence: "high" if leadsWithSignal >= 10, "low" if < 10

Return ONLY valid JSON (no other text):
{
  "signalEffectiveness": [
    {
      "signal": "signal theme description",
      "leadsWithSignal": 0,
      "repliedWithSignal": 0,
      "replyRateWithSignal": 0,
      "baselineReplyRate": 0,
      "lift": 0,
      "category": "effective",
      "confidence": "high"
    }
  ],
  "recommendations": [
    {
      "recommendation": "specific actionable recommendation",
      "type": "weight_increase",
      "confidence": "high",
      "dataPoint": "data backing this recommendation"
    }
  ]
}`;

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: ANALYSIS_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return { signalEffectiveness: [], recommendations: [] };
  }

  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { signalEffectiveness: [], recommendations: [] };
  }

  try {
    return JSON.parse(jsonMatch[0]) as {
      signalEffectiveness: SignalEffectiveness[];
      recommendations: FeedbackRecommendation[];
    };
  } catch {
    return { signalEffectiveness: [], recommendations: [] };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────────────────────────────────────

export async function analyzeLeadQuality(options?: {
  minCampaigns?: number;
  minLeads?: number;
  _analyzePatterns?: PatternAnalysisFn;
  _client?: FeedbackClient;
}): Promise<LeadQualityFeedbackReport> {
  // Step 1: Validate ANTHROPIC_API_KEY upfront (only when not injecting)
  const analyzePatterns: PatternAnalysisFn =
    options?._analyzePatterns ?? defaultAnalyzePatterns;

  if (!options?._analyzePatterns) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ConfigError(
        'Missing ANTHROPIC_API_KEY in .env.local — needed for pattern analysis',
      );
    }
  }

  const minCampaigns =
    options?.minCampaigns ??
    Number(process.env.MIN_CAMPAIGNS_FOR_FEEDBACK ?? DEFAULT_MIN_CAMPAIGNS);
  const minLeads =
    options?.minLeads ??
    Number(process.env.MIN_LEADS_FOR_FEEDBACK ?? DEFAULT_MIN_LEADS);

  // Step 2: Create client (validates GOJIBERRY_API_KEY)
  const client: FeedbackClient = options?._client ?? new GojiBerryClient();

  // Step 3a: Fetch campaigns first — AuthError propagates immediately, no partial report
  const campaigns = await client.getCampaigns();

  // Step 3b: Fetch leads and intent type counts in parallel
  const [allLeads, intentTypeCounts] = await Promise.all([
    fetchAllLeads(client),
    client.getIntentTypeCounts(),
  ]);

  // Step 4: Gate — minimum campaigns and leads
  const completedCampaigns = campaigns.filter((c) => c.status === 'completed');
  const notEnoughCampaigns = completedCampaigns.length < minCampaigns;
  const notEnoughLeads = allLeads.length < minLeads;

  if (notEnoughCampaigns || notEnoughLeads) {
    const message =
      `Not enough data yet — need at least ${minCampaigns} completed campaigns and ` +
      `${minLeads} leads with outcomes. You have ${completedCampaigns.length} campaigns ` +
      `and ${allLeads.length} leads.`;
    return makeEmptyReport(completedCampaigns.length, allLeads.length, 0, message);
  }

  // Step 5: Compute total replied from campaign metrics
  const totalSent = completedCampaigns.reduce((sum, c) => sum + (c.metrics?.sent ?? 0), 0);
  const totalReplied = completedCampaigns.reduce((sum, c) => sum + (c.metrics?.replied ?? 0), 0);

  // Step 6: Gate — zero replies
  if (totalReplied === 0) {
    const message =
      `No replies yet across ${completedCampaigns.length} campaigns — can't measure what ` +
      `predicts replies until some leads respond. Focus on improving messages first.`;
    return makeEmptyReport(
      completedCampaigns.length,
      allLeads.length,
      0,
      message,
      true, // noReplies
    );
  }

  // Step 7: Fetch replied leads separately
  const repliedLeads = await fetchAllLeads(client, { intentType: 'replied' });
  const repliedIds = new Set(repliedLeads.map((l) => l.id));
  const nonRepliedLeads = allLeads.filter((l) => !repliedIds.has(l.id));

  // Step 8: Compute intent type correlations
  const intentCorrelations = computeIntentTypeCorrelations(allLeads, repliedIds);

  // Step 9: Build pipeline funnel
  const funnel = computePipelineFunnel(allLeads, repliedLeads, completedCampaigns);

  // Step 10: Overall reply rate
  const overallReplyRate = totalSent > 0 ? (totalReplied / totalSent) * 100 : 0;

  // Step 11: Field importance (deterministic signal effectiveness)
  const fieldImportanceSignals = computeFieldImportance(allLeads, repliedIds, overallReplyRate);

  // Step 12: LLM pattern analysis
  const patternResult = await analyzePatterns(
    repliedLeads,
    nonRepliedLeads,
    allLeads,
    completedCampaigns,
  );

  // Merge LLM signals with field importance
  const allSignalEffectiveness = [...fieldImportanceSignals, ...patternResult.signalEffectiveness];
  const signalEffectiveness = {
    effective: allSignalEffectiveness.filter((s) => s.category === 'effective'),
    ineffective: allSignalEffectiveness.filter((s) => s.category === 'ineffective'),
    inconclusive: allSignalEffectiveness.filter((s) => s.category === 'inconclusive'),
  };

  // Step 13: Scoring health
  const scoringHealth = computeScoringHealth(allLeads, repliedIds);

  // Step 14: Trend
  const trend = computeFeedbackTrend(completedCampaigns);

  // Step 15: Suppress intentTypeCounts usage warning — it's fetched per spec
  void intentTypeCounts;

  // Step 16: Assemble report
  const reportData: Omit<LeadQualityFeedbackReport, 'reportText'> = {
    campaignCount: completedCampaigns.length,
    totalLeads: allLeads.length,
    totalReplied,
    overallReplyRate: round2(overallReplyRate),
    noReplies: false,
    funnel,
    intentCorrelations,
    signalEffectiveness,
    scoringHealth,
    trend,
    recommendations: patternResult.recommendations,
  };

  const reportText = buildReportText(reportData);

  return { ...reportData, reportText };
}
