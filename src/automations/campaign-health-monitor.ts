import * as fs from 'fs';
import * as path from 'path';
import { GojiBerryClient } from '../api/gojiberry-client.js';
import type { Campaign } from '../api/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────────

export type AlertSeverity = 'warning' | 'info';

export type AlertType = 'stalled' | 'low_reply_rate' | 'declining' | 'recovered' | 'too_early';

export interface CampaignAlert {
  campaignId: string;
  campaignName: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
}

export interface CampaignHealthStatus {
  campaignId: string;
  campaignName: string;
  status: string;
  sent: number;
  replyRate: number;
  lastSendEstimate: string | null;
  alerts: CampaignAlert[];
}

export interface HealthSnapshot {
  date: string;
  campaigns: Array<{
    id: string;
    alerts: AlertType[];
    replyRate: number;
    sent: number;
  }>;
}

export interface CampaignHealthReport {
  date: string;
  campaignsChecked: number;
  alerts: CampaignAlert[];
  campaignStatuses: CampaignHealthStatus[];
  recoveries: CampaignAlert[];
  reportText: string;
  snapshot: HealthSnapshot;
}

type HealthMonitorClient = Pick<GojiBerryClient, 'getCampaigns'>;

type SnapshotCampaign = HealthSnapshot['campaigns'][number];

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const DEFAULT_SNAPSHOT_DIR = 'data/health-snapshots';
const DEFAULT_STALL_THRESHOLD_DAYS = 3;
const DEFAULT_LOW_REPLY_RATE_THRESHOLD = 2; // percent
const DEFAULT_MIN_SENDS_FOR_ANALYSIS = 10;

// ──────────────────────────────────────────────────────────────────────────────
// Env helpers
// ──────────────────────────────────────────────────────────────────────────────

function parseEnvInt(envVar: string, defaultValue: number): number {
  const raw = process.env[envVar];
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return defaultValue;
}

function getCronExpr(): string {
  return process.env.CAMPAIGN_HEALTH_CRON ?? '0 9 * * *';
}

// ──────────────────────────────────────────────────────────────────────────────
// Snapshot helpers
// ──────────────────────────────────────────────────────────────────────────────

function todayString(): string {
  return new Date().toISOString().split('T')[0];
}

function loadMostRecentSnapshot(snapshotDir: string): HealthSnapshot | null {
  if (!fs.existsSync(snapshotDir)) return null;

  const files = fs
    .readdirSync(snapshotDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  const content = fs.readFileSync(path.join(snapshotDir, files[0]), 'utf-8');
  return JSON.parse(content) as HealthSnapshot;
}

function saveSnapshot(snapshotDir: string, snapshot: HealthSnapshot): void {
  if (!fs.existsSync(snapshotDir)) {
    fs.mkdirSync(snapshotDir, { recursive: true });
  }
  const filePath = path.join(snapshotDir, `${snapshot.date}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
}

// ──────────────────────────────────────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function nextHealthCheckDate(cronExpr: string): string {
  const parts = cronExpr.trim().split(/\s+/);
  const hour = parseInt(parts[1] ?? '9', 10);
  const minute = parseInt(parts[0] ?? '0', 10);

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(hour, minute, 0, 0);
  return tomorrow.toDateString();
}

function daysSince(isoDate: string): number {
  const date = new Date(isoDate);
  const now = new Date();
  return Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
}

// ──────────────────────────────────────────────────────────────────────────────
// Report text builder
// ──────────────────────────────────────────────────────────────────────────────

function buildReportText(
  date: string,
  campaignsChecked: number,
  allAlerts: CampaignAlert[],
  recoveries: CampaignAlert[],
  campaignStatuses: CampaignHealthStatus[],
  minSendsForAnalysis: number,
  cronExpr: string,
): string {
  const lines: string[] = [];
  lines.push(`=== Campaign Health Check (${date}) ===`);
  lines.push('');

  const totalIssues = allAlerts.length + recoveries.length;

  if (allAlerts.length === 0 && recoveries.length === 0) {
    lines.push('All campaigns healthy — no issues detected');
  } else {
    lines.push(`Status: ${campaignsChecked} active campaigns checked — ${totalIssues} issues found`);
  }

  // Alerts section
  if (allAlerts.length > 0 || recoveries.length > 0) {
    lines.push('');
    lines.push('--- Alerts ---');
    for (const alert of allAlerts) {
      lines.push(`  ⚠️  ${alert.message}`);
    }
    for (const recovery of recoveries) {
      lines.push(`  ✅  "${recovery.campaignName}" — Recovered: ${recovery.message}`);
    }
  }

  // Campaign summary
  lines.push('');
  lines.push('--- Campaign Summary ---');
  for (const cs of campaignStatuses) {
    if (cs.sent < minSendsForAnalysis && cs.alerts.every((a) => a.type !== 'stalled')) {
      lines.push(`  "${cs.campaignName}": too early (${cs.sent}/${minSendsForAnalysis} sends)`);
    } else {
      lines.push(
        `  "${cs.campaignName}": ${cs.sent} sent, ${cs.replyRate}% reply rate — ${cs.status}`,
      );
    }
  }

  // What to do (only when issues exist)
  if (allAlerts.length > 0 || recoveries.length > 0) {
    const nextAction = determineNextAction(allAlerts);
    lines.push('');
    lines.push('--- What to Do ---');
    lines.push(`  ${nextAction}`);
  }

  lines.push('');
  lines.push(`Next health check: ${nextHealthCheckDate(cronExpr)}`);

  return lines.join('\n');
}

function determineNextAction(alerts: CampaignAlert[]): string {
  const hasStall = alerts.some((a) => a.type === 'stalled');
  const hasLowReply = alerts.some((a) => a.type === 'low_reply_rate');

  if (hasStall && hasLowReply) {
    return 'Check stalled campaigns in GojiBerry and review message copy for low-performing campaigns';
  }
  if (hasStall) {
    return 'Check stalled campaign(s) in GojiBerry — they may be paused or out of leads';
  }
  if (hasLowReply) {
    return 'Review message copy for low-performing campaigns — consider A/B testing or pausing';
  }
  return 'Review flagged campaigns in GojiBerry';
}

function buildNoCampaignsText(
  date: string,
  paused: number,
  draft: number,
  cronExpr: string,
): string {
  const lines: string[] = [];
  lines.push(`=== Campaign Health Check (${date}) ===`);
  lines.push('');

  if (paused > 0 || draft > 0) {
    lines.push(
      `No active campaigns to monitor — you have ${paused} paused and ${draft} draft campaigns`,
    );
    lines.push('');
    lines.push('--- What to Do ---');
    lines.push('  Resume a paused campaign or launch a draft to get outreach running');
  } else {
    lines.push(
      'No active campaigns to monitor — launch a campaign in GojiBerry to start tracking',
    );
  }

  lines.push('');
  lines.push(`Next health check: ${nextHealthCheckDate(cronExpr)}`);

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Per-campaign analysis
// ──────────────────────────────────────────────────────────────────────────────

interface CampaignAnalysis {
  status: CampaignHealthStatus;
  alerts: CampaignAlert[];
  recovery: CampaignAlert | null;
}

function analyzeCampaign(
  campaign: Campaign,
  prevData: SnapshotCampaign | null,
  stallThresholdDays: number,
  lowReplyRateThreshold: number,
  minSendsForAnalysis: number,
): CampaignAnalysis {
  const metrics = campaign.metrics ?? { sent: 0, opened: 0, replied: 0, converted: 0 };
  const sent = metrics.sent;
  const replyRate = sent > 0 ? (metrics.replied / sent) * 100 : 0;
  const lastSendEstimate = campaign.updatedAt ?? null;
  const alerts: CampaignAlert[] = [];

  // ── Stall check ──────────────────────────────────────────────────────────
  let isStalled = false;
  if (lastSendEstimate) {
    const days = daysSince(lastSendEstimate);
    if (days >= stallThresholdDays) {
      isStalled = true;
      alerts.push({
        campaignId: campaign.id,
        campaignName: campaign.name,
        type: 'stalled',
        severity: 'warning',
        message: `Campaign '${campaign.name}' appears stalled — no sends in ${days} days. Check if it's paused or out of leads.`,
      });
    }
  }

  // ── Reply rate check ─────────────────────────────────────────────────────
  if (sent >= minSendsForAnalysis && replyRate < lowReplyRateThreshold) {
    const roundedRate = round2(replyRate);
    alerts.push({
      campaignId: campaign.id,
      campaignName: campaign.name,
      type: 'low_reply_rate',
      severity: 'warning',
      message: `Campaign '${campaign.name}' has a ${roundedRate}% reply rate after ${sent} sends — consider revising messages or pausing`,
    });

    // Declining check: was healthy last run, now below threshold
    if (
      prevData &&
      !prevData.alerts.includes('low_reply_rate') &&
      prevData.replyRate >= lowReplyRateThreshold
    ) {
      alerts.push({
        campaignId: campaign.id,
        campaignName: campaign.name,
        type: 'declining',
        severity: 'warning',
        message: `Reply rate dropped from ${round2(prevData.replyRate)}% to ${roundedRate}%`,
      });
    }
  }

  // ── Recovery check ───────────────────────────────────────────────────────
  let recovery: CampaignAlert | null = null;
  if (prevData?.alerts.includes('stalled') && !isStalled) {
    recovery = {
      campaignId: campaign.id,
      campaignName: campaign.name,
      type: 'recovered',
      severity: 'info',
      message: `Campaign '${campaign.name}' is active again — previously flagged as stalled`,
    };
  }

  // ── Status string ────────────────────────────────────────────────────────
  let statusStr: string;
  if (sent < minSendsForAnalysis && !isStalled) {
    statusStr = `too early to evaluate — ${sent}/${minSendsForAnalysis} sends`;
  } else if (alerts.length > 0) {
    statusStr = alerts.map((a) => a.type.replace(/_/g, ' ')).join(', ');
  } else {
    statusStr = 'healthy';
  }

  return {
    alerts,
    recovery,
    status: {
      campaignId: campaign.id,
      campaignName: campaign.name,
      status: statusStr,
      sent,
      replyRate: round2(replyRate),
      lastSendEstimate,
      alerts,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Main export
// ──────────────────────────────────────────────────────────────────────────────

export async function checkCampaignHealth(options?: {
  _client?: HealthMonitorClient;
  _snapshotDir?: string;
  stallThresholdDays?: number;
  lowReplyRateThreshold?: number;
  minSendsForAnalysis?: number;
}): Promise<CampaignHealthReport> {
  const client: HealthMonitorClient = options?._client ?? new GojiBerryClient();
  const snapshotDir = options?._snapshotDir ?? DEFAULT_SNAPSHOT_DIR;
  const stallThresholdDays =
    options?.stallThresholdDays ??
    parseEnvInt('STALL_THRESHOLD_DAYS', DEFAULT_STALL_THRESHOLD_DAYS);
  const lowReplyRateThreshold =
    options?.lowReplyRateThreshold ??
    parseEnvInt('LOW_REPLY_RATE_THRESHOLD', DEFAULT_LOW_REPLY_RATE_THRESHOLD);
  const minSendsForAnalysis =
    options?.minSendsForAnalysis ??
    parseEnvInt('MIN_SENDS_FOR_ANALYSIS', DEFAULT_MIN_SENDS_FOR_ANALYSIS);

  const cronExpr = getCronExpr();
  const date = todayString();

  // Fetch campaigns — throws AuthError if invalid key (intentional, do not catch)
  const campaigns = await client.getCampaigns();

  const activeCampaigns = campaigns.filter((c) => c.status === 'active');

  // Handle no active campaigns
  if (activeCampaigns.length === 0) {
    const paused = campaigns.filter((c) => c.status === 'paused').length;
    const draft = campaigns.filter((c) => c.status === 'draft').length;

    const reportText = buildNoCampaignsText(date, paused, draft, cronExpr);
    const emptySnapshot: HealthSnapshot = { date, campaigns: [] };

    return {
      date,
      campaignsChecked: 0,
      alerts: [],
      campaignStatuses: [],
      recoveries: [],
      reportText,
      snapshot: emptySnapshot,
    };
  }

  // Load previous snapshot for comparison
  const previousSnapshot = loadMostRecentSnapshot(snapshotDir);

  const campaignStatuses: CampaignHealthStatus[] = [];
  const allAlerts: CampaignAlert[] = [];
  const recoveries: CampaignAlert[] = [];

  for (const campaign of activeCampaigns) {
    const prevData = previousSnapshot?.campaigns.find((c) => c.id === campaign.id) ?? null;
    const { status, alerts, recovery } = analyzeCampaign(
      campaign,
      prevData,
      stallThresholdDays,
      lowReplyRateThreshold,
      minSendsForAnalysis,
    );
    campaignStatuses.push(status);
    allAlerts.push(...alerts);
    if (recovery) recoveries.push(recovery);
  }

  // Build snapshot
  const snapshot: HealthSnapshot = {
    date,
    campaigns: campaignStatuses.map((cs) => ({
      id: cs.campaignId,
      alerts: cs.alerts.map((a) => a.type),
      replyRate: cs.replyRate,
      sent: cs.sent,
    })),
  };

  // Build report text
  const reportText = buildReportText(
    date,
    activeCampaigns.length,
    allAlerts,
    recoveries,
    campaignStatuses,
    minSendsForAnalysis,
    cronExpr,
  );

  // Save snapshot
  saveSnapshot(snapshotDir, snapshot);

  return {
    date,
    campaignsChecked: activeCampaigns.length,
    alerts: allAlerts,
    campaignStatuses,
    recoveries,
    reportText,
    snapshot,
  };
}
