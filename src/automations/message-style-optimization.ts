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
const DEFAULT_MIN_MESSAGES = 10;
const MIN_SAMPLE_FOR_HIGH_CONFIDENCE = 10;
const ANTHROPIC_MODEL = 'claude-opus-4-6';
const ANALYSIS_MAX_TOKENS = 4096;

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface HookStyleAnalysis {
  style: string;
  count: number;
  replied: number;
  replyRate: number;
  confidence: 'high' | 'low';
}

export interface LengthBucket {
  range: string;
  label: string;
  count: number;
  replied: number;
  replyRate: number;
}

export interface SignalEffectiveness {
  signalType: string;
  count: number;
  replied: number;
  replyRate: number;
  impact: 'drives_replies' | 'no_impact' | 'hurts';
  confidence: 'high' | 'low';
}

export interface PhraseAnalysis {
  phrase: string;
  count: number;
  replied: number;
  replyRate: number;
}

export interface StyleRecommendation {
  type: 'hook_style' | 'message_length' | 'signal_priority' | 'tone' | 'phrase_avoid';
  recommendation: string;
  data: string;
  confidence: 'high' | 'low';
  envVar?: string;
  suggestedValue?: string;
}

export interface MessageStyleReport {
  campaignCount: number;
  totalMessaged: number;
  totalReplied: number;
  overallReplyRate: number;
  hookStyles: HookStyleAnalysis[];
  lengthBuckets: LengthBucket[];
  avgLengthReplied: number;
  avgLengthNoReply: number;
  signalEffectiveness: SignalEffectiveness[];
  phrasesToAvoid: PhraseAnalysis[];
  patternsToWatch: (HookStyleAnalysis | SignalEffectiveness)[];
  recommendations: StyleRecommendation[];
  reportText: string;
}

export type MessagePatternAnalysisFn = (
  repliedMessages: { lead: Lead; message: string }[],
  nonRepliedMessages: { lead: Lead; message: string }[],
  currentTone: string,
) => Promise<{
  hookStyles: HookStyleAnalysis[];
  lengthBuckets: LengthBucket[];
  avgLengthReplied: number;
  avgLengthNoReply: number;
  signalEffectiveness: SignalEffectiveness[];
  phrasesToAvoid: PhraseAnalysis[];
  patternsToWatch: (HookStyleAnalysis | SignalEffectiveness)[];
  recommendations: StyleRecommendation[];
}>;

type StyleOptClient = Pick<GojiBerryClient, 'getCampaigns' | 'searchLeads'>;

export interface MessageStyleOptions {
  minCampaigns?: number;
  minMessages?: number;
  currentTone?: string;
  _analyzePatterns?: MessagePatternAnalysisFn;
  _client?: StyleOptClient;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function makeEmptyReport(
  campaignCount: number,
  totalMessaged: number,
  totalReplied: number,
  message: string,
): MessageStyleReport {
  return {
    campaignCount,
    totalMessaged,
    totalReplied,
    overallReplyRate: 0,
    hookStyles: [],
    lengthBuckets: [],
    avgLengthReplied: 0,
    avgLengthNoReply: 0,
    signalEffectiveness: [],
    phrasesToAvoid: [],
    patternsToWatch: [],
    recommendations: [],
    reportText: message,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Report text builder
// ──────────────────────────────────────────────────────────────────────────────

function buildReportText(report: Omit<MessageStyleReport, 'reportText'>): string {
  const lines: string[] = [];

  lines.push('=== Message Style Optimization Report ===');
  lines.push('');
  lines.push(
    `Based on ${report.campaignCount} campaigns, ${report.totalMessaged} leads messaged, ` +
      `${report.totalReplied} replies (${round2(report.overallReplyRate)}%)`,
  );

  // Hook Style Analysis
  if (report.hookStyles.length > 0) {
    lines.push('');
    lines.push('--- Hook Style Analysis ---');

    const sorted = [...report.hookStyles].sort((a, b) => b.replyRate - a.replyRate);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];

    lines.push(`  Best:  ${best.style} — ${round2(best.replyRate)}% reply rate (${best.count} messages)`);
    lines.push(`  Worst: ${worst.style} — ${round2(worst.replyRate)}% reply rate (${worst.count} messages)`);
    lines.push('');
    lines.push('  Breakdown:');
    for (const h of report.hookStyles) {
      lines.push(
        `    ${h.style.padEnd(20)} ${round2(h.replyRate)}% (${h.count} sent, ${h.replied} replies)`,
      );
    }
  }

  // Message Length Analysis
  lines.push('');
  lines.push('--- Message Length Analysis ---');

  if (report.lengthBuckets.length > 0) {
    const bestBucket = [...report.lengthBuckets].sort((a, b) => b.replyRate - a.replyRate)[0];
    lines.push(`  Optimal range: ${bestBucket.label} characters`);
    lines.push('');
    for (const b of report.lengthBuckets) {
      lines.push(
        `  ${b.label.padEnd(20)} ${round2(b.replyRate)}% reply rate (${b.count} messages)`,
      );
    }
  } else {
    lines.push('  Optimal range: N/A');
  }

  lines.push('');
  lines.push(`  Avg length (replied): ${report.avgLengthReplied} chars`);
  lines.push(`  Avg length (no reply): ${report.avgLengthNoReply} chars`);

  // Signal Effectiveness
  if (report.signalEffectiveness.length > 0) {
    lines.push('');
    lines.push('--- Signal Effectiveness ---');

    const drivers = report.signalEffectiveness.filter((s) => s.impact === 'drives_replies');
    const noImpact = report.signalEffectiveness.filter((s) => s.impact === 'no_impact');
    const hurts = report.signalEffectiveness.filter((s) => s.impact === 'hurts');

    if (drivers.length > 0) {
      lines.push('  Drives replies:');
      for (const s of drivers) {
        lines.push(`    ${s.signalType}: ${round2(s.replyRate)}% reply rate when referenced`);
      }
    }
    if (noImpact.length > 0) {
      lines.push('  No impact:');
      for (const s of noImpact) {
        lines.push(`    ${s.signalType}: ${round2(s.replyRate)}% reply rate — same as baseline`);
      }
    }
    if (hurts.length > 0) {
      lines.push('  Hurts reply rate:');
      for (const s of hurts) {
        lines.push(`    ${s.signalType}: ${round2(s.replyRate)}% reply rate`);
      }
    }
  }

  // Phrases to Avoid
  if (report.phrasesToAvoid.length > 0) {
    lines.push('');
    lines.push('--- Phrases to Avoid ---');
    for (const p of report.phrasesToAvoid) {
      lines.push(`  "${p.phrase}": ${round2(p.replyRate)}% reply rate in messages containing it`);
    }
  }

  // Patterns to Watch (low confidence)
  if (report.patternsToWatch.length > 0) {
    lines.push('');
    lines.push('--- Patterns to Watch (low confidence) ---');
    for (const p of report.patternsToWatch) {
      const label = 'style' in p ? p.style : p.signalType;
      lines.push(
        `  ${label}: promising at ${round2(p.replyRate)}% but only ${p.count} messages — low confidence, needs more data`,
      );
    }
  }

  // Recommendations
  if (report.recommendations.length > 0) {
    lines.push('');
    lines.push('--- Recommendations ---');
    report.recommendations.forEach((r, i) => {
      lines.push(`  ${i + 1}. ${r.recommendation} (${r.data})`);
    });
  }

  // Next Steps
  lines.push('');
  lines.push('--- Next Steps ---');

  const envVarRecs = report.recommendations.filter((r) => r.envVar);
  if (envVarRecs.length > 0) {
    for (const r of envVarRecs) {
      lines.push(`  - Update ${r.envVar} to "${r.suggestedValue}" in .env.local`);
    }
  }
  lines.push('  - Run message generation with forceRegenerate to apply new style to existing leads');

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Real Anthropic pattern analysis
// ──────────────────────────────────────────────────────────────────────────────

export async function defaultAnalyzePatterns(
  repliedMessages: { lead: Lead; message: string }[],
  nonRepliedMessages: { lead: Lead; message: string }[],
  currentTone: string,
): Promise<{
  hookStyles: HookStyleAnalysis[];
  lengthBuckets: LengthBucket[];
  avgLengthReplied: number;
  avgLengthNoReply: number;
  signalEffectiveness: SignalEffectiveness[];
  phrasesToAvoid: PhraseAnalysis[];
  patternsToWatch: (HookStyleAnalysis | SignalEffectiveness)[];
  recommendations: StyleRecommendation[];
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      'Missing ANTHROPIC_API_KEY in .env.local — required for message pattern analysis',
    );
  }

  const anthropic = new Anthropic({ apiKey });

  const prompt = `You are analyzing outbound sales message data to identify what message styles drive replies.

Current tone setting: "${currentTone}"

Messages from leads who REPLIED (${repliedMessages.length} total):
${JSON.stringify(
  repliedMessages.map((m) => ({
    message: m.message,
    jobTitle: m.lead.jobTitle,
    company: m.lead.company,
    intentSignals: m.lead.intentSignals,
  })),
  null,
  2,
)}

Messages from leads who did NOT reply (${nonRepliedMessages.length} total):
${JSON.stringify(
  nonRepliedMessages.map((m) => ({
    message: m.message,
    jobTitle: m.lead.jobTitle,
    company: m.lead.company,
    intentSignals: m.lead.intentSignals,
  })),
  null,
  2,
)}

Analyze the messages and identify:
1. Hook styles (classify each message opening as: question, compliment, direct_ask, mutual_connection, or other)
2. Message length patterns (bucket into under_150, 150_250, 250_plus)
3. Signal types referenced (hiring, fundraising, product_launch, content_activity, job_change, other)
4. Weak phrases that correlate with non-reply
5. Overall style recommendations

For confidence: "high" if count >= 10, "low" if count < 10.
For signal impact: "drives_replies" if replyRate > overallRate * 1.2, "hurts" if < overallRate * 0.8, else "no_impact".

Return ONLY a valid JSON object with this exact structure (no other text):
{
  "hookStyles": [
    { "style": "question", "count": 0, "replied": 0, "replyRate": 0, "confidence": "high" }
  ],
  "lengthBuckets": [
    { "range": "under_150", "label": "Under 150 chars", "count": 0, "replied": 0, "replyRate": 0 },
    { "range": "150_250", "label": "150-250 chars", "count": 0, "replied": 0, "replyRate": 0 },
    { "range": "250_plus", "label": "250+ chars", "count": 0, "replied": 0, "replyRate": 0 }
  ],
  "avgLengthReplied": 0,
  "avgLengthNoReply": 0,
  "signalEffectiveness": [
    { "signalType": "hiring", "count": 0, "replied": 0, "replyRate": 0, "impact": "drives_replies", "confidence": "high" }
  ],
  "phrasesToAvoid": [
    { "phrase": "string", "count": 0, "replied": 0, "replyRate": 0 }
  ],
  "patternsToWatch": [],
  "recommendations": [
    {
      "type": "hook_style",
      "recommendation": "string",
      "data": "data-backed explanation with numbers",
      "confidence": "high",
      "envVar": "MESSAGE_TONE",
      "suggestedValue": "casual"
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
    return {
      hookStyles: [],
      lengthBuckets: [],
      avgLengthReplied: 0,
      avgLengthNoReply: 0,
      signalEffectiveness: [],
      phrasesToAvoid: [],
      patternsToWatch: [],
      recommendations: [],
    };
  }

  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      hookStyles: [],
      lengthBuckets: [],
      avgLengthReplied: 0,
      avgLengthNoReply: 0,
      signalEffectiveness: [],
      phrasesToAvoid: [],
      patternsToWatch: [],
      recommendations: [],
    };
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {
      hookStyles: [],
      lengthBuckets: [],
      avgLengthReplied: 0,
      avgLengthNoReply: 0,
      signalEffectiveness: [],
      phrasesToAvoid: [],
      patternsToWatch: [],
      recommendations: [],
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────────────────────────────────────

export async function optimizeMessageStyle(
  options?: MessageStyleOptions,
): Promise<MessageStyleReport> {
  const minCampaigns =
    options?.minCampaigns ??
    Number(process.env.MIN_CAMPAIGNS_FOR_STYLE_ANALYSIS ?? DEFAULT_MIN_CAMPAIGNS);

  const minMessages =
    options?.minMessages ??
    Number(process.env.MIN_MESSAGES_FOR_ANALYSIS ?? DEFAULT_MIN_MESSAGES);

  const currentTone =
    options?.currentTone ?? process.env.MESSAGE_TONE ?? 'professional';

  const client: StyleOptClient = options?._client ?? new GojiBerryClient();
  const analyzePatterns: MessagePatternAnalysisFn =
    options?._analyzePatterns ?? defaultAnalyzePatterns;

  // Step 1: Fetch campaigns — AuthError propagates
  const campaigns = await client.getCampaigns();
  const completedCampaigns = campaigns.filter((c) => c.status === 'completed');

  // Step 2: Gate — minimum completed campaigns
  if (completedCampaigns.length < minCampaigns) {
    const message =
      `Not enough campaign data yet — need at least ${minCampaigns} completed campaigns ` +
      `with replies to analyze message styles. You have ${completedCampaigns.length}.`;
    return makeEmptyReport(completedCampaigns.length, 0, 0, message);
  }

  // Step 3: Fetch replied and all messaged leads in parallel
  const [repliedResult, allLeadsResult] = await Promise.all([
    client.searchLeads({ intentType: 'replied' }),
    client.searchLeads(),
  ]);

  // Step 4: Derive non-replied leads and filter to those with personalizedMessages
  const repliedIds = new Set(repliedResult.leads.map((l) => l.id));
  const allLeadsWithMessages = allLeadsResult.leads.filter(
    (l) => l.personalizedMessages && l.personalizedMessages.length > 0,
  );
  const repliedLeadsWithMessages = repliedResult.leads.filter(
    (l) => l.personalizedMessages && l.personalizedMessages.length > 0,
  );
  const nonRepliedLeadsWithMessages = allLeadsWithMessages.filter(
    (l) => !repliedIds.has(l.id),
  );

  const totalMessaged = allLeadsWithMessages.length;
  const totalReplied = repliedLeadsWithMessages.length;

  // Step 5: Gate — minimum messaged leads
  if (totalMessaged < minMessages) {
    const message =
      `Not enough messaged leads yet — need at least ${minMessages} leads with messages to analyze patterns. ` +
      `You have ${totalMessaged}.`;
    return makeEmptyReport(completedCampaigns.length, totalMessaged, totalReplied, message);
  }

  // Step 6: Gate — zero replies
  if (totalReplied === 0) {
    const message =
      `No replies yet — can't optimize what hasn't been validated. ` +
      `Focus on ICP refinement first to ensure you're reaching the right people.`;
    return makeEmptyReport(completedCampaigns.length, totalMessaged, 0, message);
  }

  // Step 7: Extract message text from personalizedMessages[0]
  const repliedMessages = repliedLeadsWithMessages.map((lead) => ({
    lead,
    message: lead.personalizedMessages![0],
  }));
  const nonRepliedMessages = nonRepliedLeadsWithMessages.map((lead) => ({
    lead,
    message: lead.personalizedMessages![0],
  }));

  // Step 8: Delegate pattern analysis to Claude (or injected fn)
  const analysis = await analyzePatterns(repliedMessages, nonRepliedMessages, currentTone);

  // Step 9: Apply confidence override based on sample size
  const processedHookStyles = analysis.hookStyles.map((h) => ({
    ...h,
    confidence: (h.count < MIN_SAMPLE_FOR_HIGH_CONFIDENCE ? 'low' : h.confidence) as 'high' | 'low',
  }));

  const overallReplyRate = totalMessaged > 0 ? (totalReplied / totalMessaged) * 100 : 0;

  const reportData = {
    campaignCount: completedCampaigns.length,
    totalMessaged,
    totalReplied,
    overallReplyRate,
    hookStyles: processedHookStyles,
    lengthBuckets: analysis.lengthBuckets,
    avgLengthReplied: analysis.avgLengthReplied,
    avgLengthNoReply: analysis.avgLengthNoReply,
    signalEffectiveness: analysis.signalEffectiveness,
    phrasesToAvoid: analysis.phrasesToAvoid,
    patternsToWatch: analysis.patternsToWatch,
    recommendations: analysis.recommendations,
  };

  const reportText = buildReportText(reportData);

  return { ...reportData, reportText };
}
