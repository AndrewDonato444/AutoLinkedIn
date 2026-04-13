import type { GojiBerryClient } from '../api/gojiberry-client.js';
import type { Campaign, Lead, List } from '../api/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface ScoreTiers {
  hot: number;      // 80–100
  warm: number;     // 50–79
  cool: number;     // 20–49
  cold: number;     // 0–19
  unscored: number; // no fitScore
}

export interface PipelineOverviewReport {
  generatedAt: string;
  contacts: {
    total: number;
    byIntentType: Record<string, number>;
    byScoreTier: ScoreTiers;
  };
  campaigns: {
    total: number;
    byStatus: Record<string, number>;
    metrics: {
      totalSent: number;
      totalOpened: number;
      totalReplied: number;
      totalConverted: number;
    };
  };
  lists: {
    total: number;
    totalLeadsInLists: number;
  };
  summary: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

const FETCH_PAGE_SIZE = 250;

function pluralize(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

type PipelineClient = Pick<
  GojiBerryClient,
  'searchLeads' | 'getIntentTypeCounts' | 'getCampaigns' | 'getLists'
>;

async function fetchAllLeads(client: PipelineClient): Promise<{ leads: Lead[]; total: number }> {
  const allLeads: Lead[] = [];
  let page = 1;
  let total = 0;

  do {
    const result = await client.searchLeads({ page, pageSize: FETCH_PAGE_SIZE });
    total = result.total;
    allLeads.push(...result.leads);
    page++;
  } while (allLeads.length < total);

  return { leads: allLeads, total };
}

function classifyScoreTier(score?: number): keyof ScoreTiers {
  if (score === undefined || score === null) return 'unscored';
  if (score >= 80) return 'hot';
  if (score >= 50) return 'warm';
  if (score >= 20) return 'cool';
  return 'cold';
}

function computeScoreTiers(leads: Lead[]): ScoreTiers {
  const tiers: ScoreTiers = { hot: 0, warm: 0, cool: 0, cold: 0, unscored: 0 };
  for (const lead of leads) {
    tiers[classifyScoreTier(lead.fitScore)]++;
  }
  return tiers;
}

function aggregateCampaigns(campaigns: Campaign[]): PipelineOverviewReport['campaigns'] {
  const byStatus: Record<string, number> = {};
  let totalSent = 0;
  let totalOpened = 0;
  let totalReplied = 0;
  let totalConverted = 0;

  for (const campaign of campaigns) {
    byStatus[campaign.status] = (byStatus[campaign.status] ?? 0) + 1;
    if (campaign.metrics) {
      totalSent += campaign.metrics.sent;
      totalOpened += campaign.metrics.opened;
      totalReplied += campaign.metrics.replied;
      totalConverted += campaign.metrics.converted;
    }
  }

  return {
    total: campaigns.length,
    byStatus,
    metrics: { totalSent, totalOpened, totalReplied, totalConverted },
  };
}

function aggregateLists(lists: List[]): PipelineOverviewReport['lists'] {
  return {
    total: lists.length,
    totalLeadsInLists: lists.reduce((sum, l) => sum + l.leadCount, 0),
  };
}

function generateSummary(
  contacts: PipelineOverviewReport['contacts'],
  campaigns: PipelineOverviewReport['campaigns'],
): string {
  const { total, byScoreTier, byIntentType } = contacts;
  const sentences: string[] = [];

  // Sentence 1: contact total and score tier breakdown
  sentences.push(
    `Your pipeline has ${pluralize(total, 'contact')} — ` +
      `${byScoreTier.hot} hot, ${byScoreTier.warm} warm, ${byScoreTier.cool} cool, ` +
      `${byScoreTier.cold} cold, and ${byScoreTier.unscored} unscored.`,
  );

  // Sentence 2: top intent type (or indicate none)
  const intentEntries = Object.entries(byIntentType).sort(([, a], [, b]) => b - a);
  if (intentEntries.length > 0) {
    const [topType, topCount] = intentEntries[0];
    sentences.push(`The top intent type is '${topType}' with ${pluralize(topCount, 'contact')}.`);
  } else {
    sentences.push('No intent data available.');
  }

  // Sentence 3: campaigns
  if (campaigns.total === 0) {
    sentences.push('No active campaigns in your pipeline.');
  } else {
    const statusParts = Object.entries(campaigns.byStatus)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ');
    sentences.push(`You have ${pluralize(campaigns.total, 'campaign')}: ${statusParts}.`);

    // Sentence 4: reply rate (only when messages were sent)
    if (campaigns.metrics.totalSent > 0) {
      const replyRate = Math.round(
        (campaigns.metrics.totalReplied / campaigns.metrics.totalSent) * 100,
      );
      sentences.push(
        `Across all campaigns, ${pluralize(campaigns.metrics.totalSent, 'message')} sent with a ${replyRate}% reply rate.`,
      );
    }
  }

  return sentences.join(' ');
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Fetches contact, campaign, and intent data from the GojiBerry API and
 * produces a structured pipeline snapshot with a plain-English summary.
 *
 * Throws on API errors (auth, network) — the caller is responsible for retries.
 */
export async function generatePipelineOverview(
  client: GojiBerryClient,
): Promise<PipelineOverviewReport> {
  const [{ leads, total }, byIntentType, campaigns, lists] = await Promise.all([
    fetchAllLeads(client),
    client.getIntentTypeCounts(),
    client.getCampaigns(),
    client.getLists(),
  ]);

  const byScoreTier = computeScoreTiers(leads);
  const contacts = { total, byIntentType, byScoreTier };
  const campaignData = aggregateCampaigns(campaigns);
  const listsData = aggregateLists(lists);
  const summary = generateSummary(contacts, campaignData);

  return {
    generatedAt: new Date().toISOString(),
    contacts,
    campaigns: campaignData,
    lists: listsData,
    summary,
  };
}
