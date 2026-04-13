import * as fs from 'fs';
import * as path from 'path';
import { GojiBerryClient } from '../api/gojiberry-client.js';
import { AuthError } from '../api/errors.js';
import { generatePipelineOverview, type PipelineOverviewReport } from './pipeline-overview-report.js';
import { buildWarmLeadList, type WarmLead, type WarmLeadListResult } from './warm-lead-list-builder.js';

// ──────────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────────

export interface BriefingSnapshot {
  date: string;
  totalLeads: number;
  byTier: {
    hot: number;
    warm: number;
    cool: number;
    cold: number;
    unscored: number;
  };
  campaignCount: number;
  topLeadIds: string[];
}

export interface OvernightChanges {
  newLeads: number;
  newlyWarm: number;
  previousSnapshot: BriefingSnapshot | null;
}

export interface MorningBriefing {
  date: string;
  pipeline: PipelineOverviewReport;
  topLeads: WarmLead[];
  totalWarmLeads: number;
  overnightChanges: OvernightChanges;
  leadsWithMessages: number;
  nextAction: string;
  briefingText: string;
  snapshot: BriefingSnapshot;
}

type BriefingClient = Pick<
  GojiBerryClient,
  'searchLeads' | 'getIntentTypeCounts' | 'getCampaigns' | 'getLists'
>;

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const DEFAULT_SNAPSHOT_DIR = 'data/briefing-snapshots';
const DEFAULT_TOP_LEADS = 5;
const DEFAULT_MIN_SCORE = 50;
const FETCH_PAGE_SIZE = 250;

// ──────────────────────────────────────────────────────────────────────────────
// Env helpers
// ──────────────────────────────────────────────────────────────────────────────

function getTopLeadsCount(): number {
  const env = process.env.MORNING_BRIEFING_TOP_LEADS;
  if (env) {
    const parsed = Number(env);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return DEFAULT_TOP_LEADS;
}

function getMinIntentScore(): number {
  const env = process.env.MIN_INTENT_SCORE;
  if (env) {
    const parsed = Number(env);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return DEFAULT_MIN_SCORE;
}

function getCronExpr(): string {
  return process.env.MORNING_BRIEFING_CRON ?? '0 8 * * 1-5';
}

// ──────────────────────────────────────────────────────────────────────────────
// Snapshot helpers
// ──────────────────────────────────────────────────────────────────────────────

function todayString(): string {
  return new Date().toISOString().split('T')[0];
}

function loadMostRecentSnapshot(snapshotDir: string): BriefingSnapshot | null {
  if (!fs.existsSync(snapshotDir)) return null;

  const files = fs
    .readdirSync(snapshotDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  const content = fs.readFileSync(path.join(snapshotDir, files[0]), 'utf-8');
  return JSON.parse(content) as BriefingSnapshot;
}

function saveSnapshot(snapshotDir: string, snapshot: BriefingSnapshot): void {
  if (!fs.existsSync(snapshotDir)) {
    fs.mkdirSync(snapshotDir, { recursive: true });
  }
  const filePath = path.join(snapshotDir, `${snapshot.date}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
}

// ──────────────────────────────────────────────────────────────────────────────
// Overnight changes
// ──────────────────────────────────────────────────────────────────────────────

function computeOvernightChanges(
  current: BriefingSnapshot,
  previous: BriefingSnapshot | null,
): OvernightChanges {
  if (!previous) {
    return { newLeads: 0, newlyWarm: 0, previousSnapshot: null };
  }

  const newLeads = Math.max(0, current.totalLeads - previous.totalLeads);
  const prevWarm = previous.byTier.hot + previous.byTier.warm;
  const currWarm = current.byTier.hot + current.byTier.warm;
  const newlyWarm = Math.max(0, currWarm - prevWarm);

  return { newLeads, newlyWarm, previousSnapshot: previous };
}

// ──────────────────────────────────────────────────────────────────────────────
// Next action
// ──────────────────────────────────────────────────────────────────────────────

function determineNextAction(
  pipeline: PipelineOverviewReport,
  totalWarmLeads: number,
  leadsWithMessages: number,
  warmLeadsError: string | null,
): string {
  if (pipeline.contacts.total === 0) {
    return 'Define your ICP and run a lead scan to get started';
  }

  if (warmLeadsError) {
    return 'Check API connectivity and re-run the morning briefing';
  }

  if (totalWarmLeads === 0) {
    return 'Consider enriching more leads or adjusting your ICP';
  }

  if (leadsWithMessages > 0) {
    const plural = leadsWithMessages === 1 ? 'lead' : 'leads';
    return `You have ${leadsWithMessages} ${plural} with messages ready. Open GojiBerry to review and approve.`;
  }

  return 'Top leads need messages — run message generation or wait for the daily scan';
}

// ──────────────────────────────────────────────────────────────────────────────
// Next briefing date
// ──────────────────────────────────────────────────────────────────────────────

function nextBriefingDate(cronExpr: string): string {
  const parts = cronExpr.trim().split(/\s+/);
  const hour = parseInt(parts[1] ?? '8', 10);
  const minute = parseInt(parts[0] ?? '0', 10);

  const now = new Date();
  // Find next weekday (Mon–Fri)
  let daysAhead = 1;
  let nextDay = (now.getDay() + daysAhead) % 7;
  while (nextDay === 0 || nextDay === 6) {
    daysAhead++;
    nextDay = (now.getDay() + daysAhead) % 7;
  }

  const next = new Date(now);
  next.setDate(now.getDate() + daysAhead);
  next.setHours(hour, minute, 0, 0);
  return next.toDateString();
}

// ──────────────────────────────────────────────────────────────────────────────
// Briefing text builder
// ──────────────────────────────────────────────────────────────────────────────

function buildBriefingText(
  date: string,
  pipeline: PipelineOverviewReport,
  topLeads: WarmLead[],
  totalWarmLeads: number,
  overnightChanges: OvernightChanges,
  messagesMap: Map<string, boolean>,
  nextAction: string,
  topLeadsCount: number,
  warmLeadsError: string | null,
  cronExpr: string,
): string {
  const { contacts, campaigns } = pipeline;
  const { byScoreTier } = contacts;
  const lines: string[] = [];

  lines.push(`=== Morning Briefing (${date}) ===`);
  lines.push('');

  // Empty pipeline — zero-state
  if (contacts.total === 0) {
    lines.push('Your pipeline is empty — no leads or campaigns yet');
    lines.push('');
    lines.push('--- What to Do ---');
    lines.push(`  ${nextAction}`);
    lines.push('');
    lines.push(`Next briefing: ${nextBriefingDate(cronExpr)}`);
    return lines.join('\n');
  }

  // Pipeline summary
  const activeCampaigns = campaigns.byStatus.active ?? 0;
  lines.push(
    `Pipeline: ${contacts.total} leads — ${byScoreTier.hot} hot, ${byScoreTier.warm} warm, ${byScoreTier.cool} cool, ${byScoreTier.cold} cold`,
  );
  lines.push(
    `          ${activeCampaigns} active campaigns, ${campaigns.metrics.totalSent} messages sent`,
  );

  // Overnight changes
  if (overnightChanges.previousSnapshot === null) {
    lines.push('Overnight: first briefing — no comparison yet');
  } else {
    lines.push(
      `Overnight: +${overnightChanges.newLeads} new leads, ${overnightChanges.newlyWarm} crossed into warm`,
    );
  }
  lines.push('');

  // Top leads section
  const displayCount = Math.min(topLeadsCount, totalWarmLeads);
  const sectionLabel = displayCount > 0 ? `Top ${displayCount}` : `Top ${topLeadsCount}`;
  lines.push(`--- ${sectionLabel} Leads Right Now ---`);

  if (warmLeadsError) {
    lines.push(`  ${warmLeadsError}`);
  } else if (topLeads.length === 0) {
    const threshold = getMinIntentScore();
    lines.push(`  No warm leads right now — ${contacts.total} leads scored below ${threshold}`);
  } else {
    topLeads.forEach((lead, i) => {
      const tierLabel = lead.scoreTier === 'hot' ? 'Hot' : 'Warm';
      lines.push(
        `  ${i + 1}. ${lead.firstName} ${lead.lastName} (${lead.company}) — Score: ${lead.fitScore} [${tierLabel}]`,
      );
      lines.push(`     ${lead.jobTitle} | Intent: ${lead.intentType}`);
      lines.push(`     Why warm: ${lead.reasonForWarmth}`);
      const hasMessages = messagesMap.get(lead.id) ?? false;
      lines.push(
        `     ${hasMessages ? 'Messages ready — approve in GojiBerry' : 'Needs messages'}`,
      );
    });

    const remainingWarm = totalWarmLeads - topLeads.length;
    if (remainingWarm > 0) {
      lines.push('');
      lines.push(
        `  (${remainingWarm} more warm lead${remainingWarm === 1 ? '' : 's'} not shown — run full warm lead report for complete list)`,
      );
    }
  }
  lines.push('');

  // What to do
  lines.push('--- What to Do ---');
  lines.push(`  ${nextAction}`);
  lines.push('');
  lines.push(`Next briefing: ${nextBriefingDate(cronExpr)}`);

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Generates a daily morning briefing combining pipeline overview and warm leads.
 *
 * Partial failure tolerance: if the warm leads API fails (non-auth error), the
 * briefing still includes the pipeline summary with an error note for warm leads.
 *
 * Throws on AuthError — the caller is responsible for surfacing that.
 */
export async function generateMorningBriefing(options?: {
  _client?: BriefingClient;
  _snapshotDir?: string;
  topLeadsCount?: number;
}): Promise<MorningBriefing> {
  const client: BriefingClient = options?._client ?? new GojiBerryClient();
  const snapshotDir = options?._snapshotDir ?? DEFAULT_SNAPSHOT_DIR;
  const topLeadsCount = options?.topLeadsCount ?? getTopLeadsCount();
  const minScore = getMinIntentScore();
  const cronExpr = getCronExpr();
  const date = todayString();

  // Load previous snapshot before any API calls
  const previousSnapshot = loadMostRecentSnapshot(snapshotDir);

  // Step 1: Pipeline overview — throws on auth/network failure (intentional)
  const pipeline = await generatePipelineOverview(client as unknown as GojiBerryClient);

  // Step 2: Warm leads — partial failure is OK
  let warmLeadResult: WarmLeadListResult | null = null;
  let warmLeadsError: string | null = null;
  try {
    warmLeadResult = await buildWarmLeadList({ scoreFrom: minScore }, { _client: client });
  } catch (err) {
    if (err instanceof AuthError) throw err;
    warmLeadsError = 'Could not fetch warm leads — check API connectivity';
  }

  // Step 3: Check personalizedMessages on warm leads (best-effort, non-critical)
  const messagesMap = new Map<string, boolean>();
  let leadsWithMessages = 0;
  if (warmLeadResult && warmLeadResult.leads.length > 0) {
    try {
      const rawResult = await client.searchLeads({ scoreFrom: minScore, pageSize: FETCH_PAGE_SIZE });
      for (const lead of rawResult.leads) {
        const hasMessages = (lead.personalizedMessages?.length ?? 0) > 0;
        messagesMap.set(lead.id, hasMessages);
        if (hasMessages) leadsWithMessages++;
      }
    } catch {
      // Non-critical — continue without per-lead message status
    }
  }

  // Build top leads list
  const allWarmLeads = warmLeadResult?.leads ?? [];
  const topLeads = allWarmLeads.slice(0, topLeadsCount);
  const totalWarmLeads = warmLeadResult?.total ?? 0;

  // Build current snapshot
  const snapshot: BriefingSnapshot = {
    date,
    totalLeads: pipeline.contacts.total,
    byTier: { ...pipeline.contacts.byScoreTier },
    campaignCount: pipeline.campaigns.total,
    topLeadIds: topLeads.map((l) => l.id),
  };

  // Overnight changes
  const overnightChanges = computeOvernightChanges(snapshot, previousSnapshot);

  // Next action
  const nextAction = determineNextAction(pipeline, totalWarmLeads, leadsWithMessages, warmLeadsError);

  // Briefing text
  const briefingText = buildBriefingText(
    date,
    pipeline,
    topLeads,
    totalWarmLeads,
    overnightChanges,
    messagesMap,
    nextAction,
    topLeadsCount,
    warmLeadsError,
    cronExpr,
  );

  // Save snapshot (even on partial failure — pipeline data is valid)
  saveSnapshot(snapshotDir, snapshot);

  return {
    date,
    pipeline,
    topLeads,
    totalWarmLeads,
    overnightChanges,
    leadsWithMessages,
    nextAction,
    briefingText,
    snapshot,
  };
}
