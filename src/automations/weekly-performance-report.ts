import * as fs from 'fs';
import * as path from 'path';
import { GojiBerryClient } from '../api/gojiberry-client.js';
import {
  analyzeCampaignPerformance,
  type CampaignReport,
} from './campaign-performance-analytics.js';

// ──────────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────────

export interface WeeklySnapshot {
  date: string;
  avgReplyRate: number;
  avgOpenRate: number;
  totalSent: number;
  totalReplied: number;
  campaignCount: number;
}

export interface WeeklyReport {
  currentWeek: CampaignReport;
  previousWeek: WeeklySnapshot | null;
  deltas: {
    replyRate: number | null;
    openRate: number | null;
    sentChange: number | null;
  };
  recommendations: string[];
  reportText: string;
  snapshot: WeeklySnapshot;
}

type WeeklyReportClient = Pick<GojiBerryClient, 'getCampaigns'>;

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const DEFAULT_SNAPSHOT_DIR = 'data/weekly-snapshots';
const MAX_RECOMMENDATIONS = 3;
const MIN_SENDS_FOR_PAUSE_REVIEW = 20;
const LOW_REPLY_RATE_THRESHOLD_PCT = 3;
const TOP_CAMPAIGN_DOMINANCE_FACTOR = 2;
const DELTA_STABILITY_THRESHOLD_PP = 0.05;
const TOP_CAMPAIGNS_TO_SHOW = 2;

// ──────────────────────────────────────────────────────────────────────────────
// Snapshot helpers
// ──────────────────────────────────────────────────────────────────────────────

function todayString(): string {
  return new Date().toISOString().split('T')[0];
}

function loadMostRecentSnapshot(snapshotDir: string): WeeklySnapshot | null {
  if (!fs.existsSync(snapshotDir)) return null;

  const files = fs
    .readdirSync(snapshotDir)
    .filter((f) => f.endsWith('.json'))
    .sort() // ISO dates sort lexicographically = chronologically
    .reverse();

  if (files.length === 0) return null;

  const content = fs.readFileSync(path.join(snapshotDir, files[0]), 'utf-8');
  return JSON.parse(content) as WeeklySnapshot;
}

function saveSnapshot(snapshotDir: string, snapshot: WeeklySnapshot): void {
  if (!fs.existsSync(snapshotDir)) {
    fs.mkdirSync(snapshotDir, { recursive: true });
  }
  const filePath = path.join(snapshotDir, `${snapshot.date}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
}

// ──────────────────────────────────────────────────────────────────────────────
// Utility
// ──────────────────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatDeltaPp(delta: number): string {
  const abs = round2(Math.abs(delta));
  return delta >= 0 ? `+${abs}pp` : `\u2212${abs}pp`; // U+2212 = −
}

function deltaIndicator(delta: number): 'improving' | 'declining' | 'stable' {
  if (delta > DELTA_STABILITY_THRESHOLD_PP) return 'improving';
  if (delta < -DELTA_STABILITY_THRESHOLD_PP) return 'declining';
  return 'stable';
}

function isStalledCampaign(c: { status: string; replied: number; sent: number }): boolean {
  return c.status === 'active' && c.replied === 0 && c.sent >= MIN_SENDS_FOR_PAUSE_REVIEW;
}

function formatSentDelta(delta: number): string {
  return delta >= 0 ? `+${delta}` : `${delta}`;
}

function nextMondayString(cron: string): string {
  // Parse a simple "M H * * 1" cron and compute next Monday at that time
  const parts = cron.trim().split(/\s+/);
  const minute = parseInt(parts[0] ?? '0', 10);
  const hour = parseInt(parts[1] ?? '8', 10);

  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, …
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntilMonday);
  next.setHours(hour, minute, 0, 0);
  return next.toDateString();
}

// ──────────────────────────────────────────────────────────────────────────────
// Recommendations
// ──────────────────────────────────────────────────────────────────────────────

function generateRecommendations(report: CampaignReport): string[] {
  const recs: string[] = [];
  const { campaigns, overallAverages } = report;
  const withSends = campaigns.filter((c) => c.sent > 0);

  // Pattern 1: Top campaign reply rate ≥ 2× average → double down
  const top = withSends[0]; // already sorted by reply rate desc
  if (
    top &&
    overallAverages.replyRate > 0 &&
    top.replyRate >= TOP_CAMPAIGN_DOMINANCE_FACTOR * overallAverages.replyRate
  ) {
    recs.push(
      `Double down on what's working in ${top.name}: replicate its approach`,
    );
  }

  // Pattern 2: Active campaign with 0 replies after 20+ sends → consider pausing
  for (const c of campaigns) {
    if (recs.length >= MAX_RECOMMENDATIONS) break;
    if (isStalledCampaign(c)) {
      recs.push(
        `Campaign ${c.name} isn't getting replies — consider pausing and revising messages`,
      );
    }
  }

  // Pattern 3: Overall reply rate < 3%
  if (
    recs.length < MAX_RECOMMENDATIONS &&
    overallAverages.replyRate < LOW_REPLY_RATE_THRESHOLD_PCT &&
    overallAverages.totalSent > 0
  ) {
    recs.push(
      'Reply rates are low across the board — review your ICP targeting and message personalization',
    );
  }

  return recs.slice(0, MAX_RECOMMENDATIONS);
}

// ──────────────────────────────────────────────────────────────────────────────
// Report text builder
// ──────────────────────────────────────────────────────────────────────────────

function buildReportText(
  currentWeek: CampaignReport,
  previousWeek: WeeklySnapshot | null,
  deltas: WeeklyReport['deltas'],
  recommendations: string[],
  dateRange: string,
  nextRunDate: string,
): string {
  const { campaigns, overallAverages } = currentWeek;

  // No campaigns at all
  if (campaigns.length === 0) {
    return 'No campaigns found — create a campaign in GojiBerry to start tracking performance';
  }

  // No sends this week
  if (overallAverages.totalSent === 0) {
    const lines = [
      'No outreach activity this week — nothing to report',
      '',
      '--- Recommendations ---',
      '  1. Launch a campaign or check if active campaigns are stalled',
    ];
    if (nextRunDate) lines.push('', `Next report: ${nextRunDate}`);
    return lines.join('\n');
  }

  const lines: string[] = [];

  lines.push(`=== Weekly Performance Report (${dateRange}) ===`);
  lines.push('');

  // Active campaign count
  const activeCampaigns = campaigns.filter((c) => c.status === 'active');
  lines.push(
    `This Week: ${activeCampaigns.length} active campaigns, ${overallAverages.totalSent} messages sent, ${round2(overallAverages.replyRate)}% avg reply rate`,
  );

  // Week-over-week line
  if (previousWeek === null) {
    lines.push('vs. Last Week: first report — no comparison yet');
  } else {
    const sentDelta = deltas.sentChange ?? 0;
    const rrDelta = deltas.replyRate ?? 0;
    const indicator = deltaIndicator(rrDelta);
    lines.push(
      `vs. Last Week: ${formatSentDelta(sentDelta)} messages sent, reply rate ${formatDeltaPp(rrDelta)} (${indicator})`,
    );
  }

  lines.push('');

  // Top campaigns
  const withSends = campaigns.filter((c) => c.sent > 0);
  const topTwo = withSends.slice(0, TOP_CAMPAIGNS_TO_SHOW);
  if (topTwo.length > 0) {
    lines.push('--- Top Campaigns This Week ---');
    topTwo.forEach((c, i) => {
      lines.push(
        `  ${i + 1}. "${c.name}" — ${round2(c.replyRate)}% reply rate (${c.replied}/${c.sent} replies)`,
      );
    });
    lines.push('');
  }

  // Needs attention (active campaigns with 0 replies after 20+ sends)
  const stalled = campaigns.filter(isStalledCampaign);
  if (stalled.length > 0) {
    lines.push('--- Needs Attention ---');
    for (const c of stalled) {
      lines.push(`  "${c.name}" — ${round2(c.replyRate)}% reply rate after ${c.sent} sends`);
    }
    lines.push('');
  }

  // Recommendations
  if (recommendations.length > 0) {
    lines.push('--- Recommendations ---');
    recommendations.forEach((rec, i) => {
      lines.push(`  ${i + 1}. ${rec}`);
    });
    lines.push('');
  }

  lines.push(`Next report: ${nextRunDate}`);

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────────────────────────────────────

export async function generateWeeklyReport(options?: {
  _client?: WeeklyReportClient;
  _snapshotDir?: string;
  lookbackDays?: number;
}): Promise<WeeklyReport> {
  const snapshotDir = options?._snapshotDir ?? DEFAULT_SNAPSHOT_DIR;
  const cronExpr = process.env.WEEKLY_REPORT_CRON ?? '0 8 * * 1';

  // Load analytics (throws AuthError or other errors — do not catch here)
  const currentWeek = await analyzeCampaignPerformance({ _client: options?._client });

  // Load previous snapshot (before any writes)
  const previousWeek = loadMostRecentSnapshot(snapshotDir);

  // Compute deltas
  let deltas: WeeklyReport['deltas'] = {
    replyRate: null,
    openRate: null,
    sentChange: null,
  };
  if (previousWeek !== null) {
    deltas = {
      replyRate: round2(currentWeek.overallAverages.replyRate - previousWeek.avgReplyRate),
      openRate: round2(currentWeek.overallAverages.openRate - previousWeek.avgOpenRate),
      sentChange: currentWeek.overallAverages.totalSent - previousWeek.totalSent,
    };
  }

  // Generate recommendations (skip if no campaigns)
  const recommendations =
    currentWeek.campaigns.length === 0 ? [] : generateRecommendations(currentWeek);

  // Build snapshot
  const snapshot: WeeklySnapshot = {
    date: todayString(),
    avgReplyRate: round2(currentWeek.overallAverages.replyRate),
    avgOpenRate: round2(currentWeek.overallAverages.openRate),
    totalSent: currentWeek.overallAverages.totalSent,
    totalReplied: currentWeek.campaigns.reduce((sum, c) => sum + c.replied, 0),
    campaignCount: currentWeek.campaigns.length,
  };

  // Date range label
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - (options?.lookbackDays ?? 7));
  const dateRange = `${weekAgo.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${today.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  const nextRunDate = nextMondayString(cronExpr);

  const reportText = buildReportText(
    currentWeek,
    previousWeek,
    deltas,
    recommendations,
    dateRange,
    nextRunDate,
  );

  // Save snapshot (after building report, so even no-activity runs persist)
  saveSnapshot(snapshotDir, snapshot);

  return {
    currentWeek,
    previousWeek,
    deltas,
    recommendations,
    reportText,
    snapshot,
  };
}
