import { GojiBerryClient } from '../api/gojiberry-client.js';
import type { Campaign } from '../api/types.js';

export interface CampaignMetrics {
  id: string;
  name: string;
  status: string;
  sent: number;
  opened: number;
  replied: number;
  converted: number;
  replyRate: number;
  openRate: number;
  conversionRate: number;
}

export interface CampaignReport {
  campaigns: CampaignMetrics[];
  topPerformer: CampaignMetrics | null;
  needsAttention: CampaignMetrics | null;
  byStatus: Record<string, CampaignMetrics[]>;
  overallAverages: {
    replyRate: number;
    openRate: number;
    conversionRate: number;
    totalSent: number;
  };
  trend: 'improving' | 'declining' | 'stable' | 'insufficient_data';
  reportText: string;
}

type AnalyticsClient = Pick<GojiBerryClient, 'getCampaigns'>;

function computeMetrics(campaign: Campaign): CampaignMetrics {
  const m = campaign.metrics ?? { sent: 0, opened: 0, replied: 0, converted: 0 };
  const sent = m.sent;
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    sent,
    opened: m.opened,
    replied: m.replied,
    converted: m.converted,
    replyRate: sent > 0 ? (m.replied / sent) * 100 : 0,
    openRate: sent > 0 ? (m.opened / sent) * 100 : 0,
    conversionRate: sent > 0 ? (m.converted / sent) * 100 : 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function avgOf(items: CampaignMetrics[], key: keyof CampaignMetrics): number {
  if (items.length === 0) return 0;
  return (items.reduce((s, c) => s + (c[key] as number), 0)) / items.length;
}

function computeTrend(
  completed: CampaignMetrics[],
): 'improving' | 'declining' | 'stable' | 'insufficient_data' {
  // Need at least 2 completed campaigns to establish a trend
  if (completed.length < 2) return 'insufficient_data';

  const withSends = completed.filter((c) => c.sent > 0);
  if (withSends.length < 2) return 'insufficient_data';

  const avgReplyRate =
    withSends.reduce((sum, c) => sum + c.replyRate, 0) / withSends.length;

  // Latest = last by array order (API returns in creation order; we use updatedAt if available)
  const latest = withSends[withSends.length - 1];
  const diff = latest.replyRate - avgReplyRate;

  // Use 5% threshold for stable
  const THRESHOLD = 5;
  if (diff > THRESHOLD) return 'improving';
  if (diff < -THRESHOLD) return 'declining';
  return 'stable';
}

function buildReportText(
  metrics: CampaignMetrics[],
  topPerformer: CampaignMetrics | null,
  needsAttention: CampaignMetrics | null,
  byStatus: Record<string, CampaignMetrics[]>,
  overallAverages: CampaignReport['overallAverages'],
  trend: CampaignReport['trend'],
  completedCampaigns: CampaignMetrics[],
): string {
  const lines: string[] = [];

  if (metrics.length === 0) {
    return 'No campaigns found in GojiBerry — launch a campaign first to see analytics';
  }

  lines.push('=== Campaign Performance Report ===');
  lines.push('');
  lines.push(
    `Overall: ${metrics.length} campaigns, ${overallAverages.totalSent} messages sent, ${round2(overallAverages.replyRate)}% avg reply rate`,
  );
  lines.push('');

  if (topPerformer) {
    lines.push(
      `Top Performer: "${topPerformer.name}" — ${round2(topPerformer.replyRate)}% reply rate (${topPerformer.replied}/${topPerformer.sent})`,
    );
  }
  if (needsAttention) {
    lines.push(
      `Needs Attention: "${needsAttention.name}" — ${round2(needsAttention.replyRate)}% reply rate (${needsAttention.replied}/${needsAttention.sent})`,
    );
  }

  // Comparison of active vs completed
  const activeCampaigns = byStatus['active'] ?? [];
  const completedInStatus = byStatus['completed'] ?? [];
  if (activeCampaigns.length > 0 && completedInStatus.length > 0) {
    const activeAvg =
      activeCampaigns.reduce((s, c) => s + c.replyRate, 0) / activeCampaigns.length;
    const completedAvg =
      completedInStatus.reduce((s, c) => s + c.replyRate, 0) / completedInStatus.length;
    const comparison =
      activeAvg > completedAvg
        ? `Active campaigns are outperforming completed ones (${round2(activeAvg)}% vs ${round2(completedAvg)}% reply rate)`
        : activeAvg < completedAvg
          ? `Active campaigns are underperforming completed ones (${round2(activeAvg)}% vs ${round2(completedAvg)}% reply rate)`
          : `Active and completed campaigns are performing equally (${round2(activeAvg)}% reply rate)`;
    lines.push('');
    lines.push(comparison);
  }

  // Per-status sections
  const statusOrder = ['active', 'completed', 'paused', 'draft'];
  const allStatuses = [
    ...statusOrder.filter((s) => byStatus[s]),
    ...Object.keys(byStatus).filter((s) => !statusOrder.includes(s)),
  ];

  for (const status of allStatuses) {
    const group = byStatus[status];
    if (!group || group.length === 0) continue;
    lines.push('');
    lines.push(`--- ${status.charAt(0).toUpperCase() + status.slice(1)} Campaigns (${group.length}) ---`);
    for (const c of group) {
      if (c.sent === 0) {
        lines.push(`  ${c.name}: no data yet`);
      } else {
        lines.push(
          `  ${c.name}: ${c.sent} sent, ${round2(c.openRate)}% opened, ${round2(c.replyRate)}% replied, ${round2(c.conversionRate)}% converted`,
        );
      }
    }
  }

  // Trend section
  lines.push('');
  lines.push('--- Trend ---');
  if (trend === 'insufficient_data') {
    lines.push('Reply rate trend: insufficient data (need 2+ completed campaigns)');
  } else {
    const completedWithSends = completedCampaigns.filter((c) => c.sent > 0);
    const latest = completedWithSends[completedWithSends.length - 1];
    const avg =
      completedWithSends.reduce((s, c) => s + c.replyRate, 0) / completedWithSends.length;
    lines.push(
      `Reply rate trend: ${trend} (latest: ${round2(latest?.replyRate ?? 0)}%, avg: ${round2(avg)}%)`,
    );
  }

  return lines.join('\n');
}

export async function analyzeCampaignPerformance(options?: {
  _client?: AnalyticsClient;
}): Promise<CampaignReport> {
  const client: AnalyticsClient = options?._client ?? new GojiBerryClient();

  const campaigns = await client.getCampaigns();

  if (campaigns.length === 0) {
    return {
      campaigns: [],
      topPerformer: null,
      needsAttention: null,
      byStatus: {},
      overallAverages: { replyRate: 0, openRate: 0, conversionRate: 0, totalSent: 0 },
      trend: 'insufficient_data',
      reportText: 'No campaigns found in GojiBerry — launch a campaign first to see analytics',
    };
  }

  // Compute metrics for all campaigns
  const allMetrics = campaigns.map(computeMetrics);

  // Sort by reply rate descending
  const sorted = [...allMetrics].sort((a, b) => b.replyRate - a.replyRate);

  // Campaigns with at least 1 send (eligible for ranking)
  const withSends = sorted.filter((c) => c.sent > 0);

  // Top performer and needs attention
  // With a single campaign that has sends, it's the top performer but no peers => needsAttention is null
  const topPerformer = withSends.length > 0 ? withSends[0] : null;
  const needsAttention = withSends.length > 1 ? withSends[withSends.length - 1] : null;

  // Group by status
  const byStatus: Record<string, CampaignMetrics[]> = {};
  for (const m of allMetrics) {
    if (!byStatus[m.status]) byStatus[m.status] = [];
    byStatus[m.status].push(m);
  }

  // Overall averages (exclude zero-send campaigns)
  const totalSent = withSends.reduce((s, c) => s + c.sent, 0);
  const overallAverages = {
    replyRate: avgOf(withSends, 'replyRate'),
    openRate: avgOf(withSends, 'openRate'),
    conversionRate: avgOf(withSends, 'conversionRate'),
    totalSent,
  };

  // Trend: based on completed campaigns in original order (by API/creation order)
  const completedCampaigns = allMetrics.filter((c) => c.status === 'completed');
  const trend = computeTrend(completedCampaigns);

  const reportText = buildReportText(
    sorted,
    topPerformer,
    needsAttention,
    byStatus,
    overallAverages,
    trend,
    completedCampaigns,
  );

  return {
    campaigns: sorted,
    topPerformer,
    needsAttention,
    byStatus,
    overallAverages,
    trend,
    reportText,
  };
}
