import dotenv from 'dotenv';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { GojiBerryClient } from '../api/gojiberry-client.js';
import { AuthError, ConfigError } from '../api/errors.js';
import { normalizeLinkedInUrl } from '../utils/linkedin-url.js';
import { readMaster } from '../contacts/master-store.js';
import type { DiscoveredLead, DiscoveryResult } from './types.js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const DEFAULT_LIMIT = 50;
const ANTHROPIC_MODEL = process.env.DISCOVERY_MODEL || 'claude-sonnet-4-6';
const WEB_SEARCH_MAX_TOKENS = 8096;
const SUMMARY_SEPARATOR_WIDTH = 80;

export type WebSearchFn = (icpDescription: string) => Promise<DiscoveredLead[]>;

type LeadClient = Pick<GojiBerryClient, 'createLead' | 'searchLeads'>;

export interface DiscoverLeadsOptions {
  icpDescription?: string;
  limit?: number;
  /**
   * Path to the master contact store for dedup. Defaults to `data/contacts.jsonl`.
   * The master store is the source of truth for dedup — callers should invoke
   * `rebuildMaster()` beforehand to ensure the master reflects the latest
   * GojiBerry state before a scan.
   */
  masterFilePath?: string;
  /** Injectable for testing — bypasses real Anthropic web search */
  _webSearch?: WebSearchFn;
  /** Injectable for testing — bypasses real GojiBerryClient construction */
  _client?: LeadClient;
  /**
   * Injectable for testing — pre-built set of normalized URLs already in the
   * master. If provided, `masterFilePath` is ignored.
   */
  _existingUrls?: Set<string>;
}

export async function defaultWebSearch(icpDescription: string): Promise<DiscoveredLead[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      'Missing ANTHROPIC_API_KEY in .env.local — required for web search',
    );
  }

  const anthropic = new Anthropic({ apiKey });

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: WEB_SEARCH_MAX_TOKENS,
    // web_search_20250305 is not in the SDK types yet — cast required
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: [{ type: 'web_search_20250305', name: 'web_search' }] as any,
    messages: [
      {
        role: 'user',
        content: `Search the web for real people who match this ICP: "${icpDescription}".

Find specific individuals with LinkedIn profiles. For each person provide:
- firstName: first name
- lastName: last name
- profileUrl: LinkedIn URL (linkedin.com/in/...)
- company: current company name
- jobTitle: current job title
- location: city and country
- icpFitReason: one sentence explaining why they match the ICP

Return ONLY a valid JSON array — no other text. Example:
[{"firstName":"Jane","lastName":"Doe","profileUrl":"https://linkedin.com/in/jane-doe","company":"Acme","jobTitle":"CEO","location":"San Francisco, CA","icpFitReason":"Series A SaaS founder in fintech actively hiring"}]

Find as many real matching people as you can. Rank them from best ICP fit to weakest.`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return [];

  const jsonMatch = textBlock.text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as DiscoveredLead[];
    return parsed.filter((l) => l.firstName && l.lastName && l.profileUrl);
  } catch {
    return [];
  }
}

function buildCreateLeadInput(lead: DiscoveredLead) {
  return {
    firstName: lead.firstName,
    lastName: lead.lastName,
    profileUrl: lead.profileUrl,
    ...(lead.company !== undefined && { company: lead.company }),
    ...(lead.jobTitle !== undefined && { jobTitle: lead.jobTitle }),
    ...(lead.location !== undefined && { location: lead.location }),
  };
}

function outputSummary(result: DiscoveryResult, limit: number): void {
  const { created, failed, limitExceeded } = result;

  if (created.length === 0 && failed.length === 0) return;

  if (limitExceeded > 0) {
    console.log(
      `${created.length} leads added (limit: ${limit}, ${limitExceeded} additional matches skipped)`,
    );
  } else if (failed.length > 0) {
    console.log(`${created.length} leads added, ${failed.length} failed (see logs)`);
  } else {
    console.log(
      `${created.length} leads found and added to GojiBerry — ready for enrichment`,
    );
  }

  if (created.length > 0) {
    console.log('\nLead Summary:');
    console.log('─'.repeat(SUMMARY_SEPARATOR_WIDTH));
    for (const lead of created) {
      const parts: string[] = [`${lead.firstName} ${lead.lastName}`];
      if (lead.company) parts.push(lead.company);
      if (lead.jobTitle) parts.push(lead.jobTitle);
      parts.push(lead.profileUrl);
      console.log(parts.join(' | '));
    }
    console.log('─'.repeat(SUMMARY_SEPARATOR_WIDTH));
  }
}

/**
 * Build a Set of normalized LinkedIn URLs already present in the master store.
 * Called at the start of each scan to dedupe against the authoritative source.
 *
 * Falls back to an empty set if the master file doesn't exist — the first
 * scan in a fresh repo would create everything.
 */
async function loadSeenUrlsFromMaster(masterFilePath?: string): Promise<Set<string>> {
  const filePath = masterFilePath ?? path.join(process.cwd(), 'data', 'contacts.jsonl');
  const contacts = await readMaster(filePath);
  const urls = new Set<string>();
  for (const c of contacts) {
    const norm = normalizeLinkedInUrl(c.profileUrl);
    if (norm) urls.add(norm);
  }
  return urls;
}

export async function discoverLeads(options: DiscoverLeadsOptions = {}): Promise<DiscoveryResult> {
  const icpDescription = options.icpDescription ?? process.env.ICP_DESCRIPTION;

  if (!icpDescription || icpDescription.trim() === '') {
    throw new ConfigError(
      'Missing ICP_DESCRIPTION in .env.local — describe your ideal customer first',
    );
  }

  const rawLimit = options.limit ?? Number(process.env.DAILY_LEAD_SCAN_LIMIT || DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

  const client: LeadClient = options._client ?? new GojiBerryClient();
  const webSearch: WebSearchFn = options._webSearch ?? defaultWebSearch;

  const result: DiscoveryResult = { created: [], skipped: [], failed: [], limitExceeded: 0 };

  // Build the dedup set from the master contact store.
  // Master is the source of truth — we skip any lead whose normalized LinkedIn
  // URL already appears there. The set also catches duplicates within a single
  // scan (two web-search results pointing at the same profile).
  const seenUrls: Set<string> = options._existingUrls
    ? new Set(options._existingUrls)
    : await loadSeenUrlsFromMaster(options.masterFilePath);

  // Step 1: Search web for leads
  const allLeads = await webSearch(icpDescription);

  if (allLeads.length === 0) {
    console.log(
      'No leads found matching your ICP — try broadening your ideal customer description',
    );
    return result;
  }

  // Step 2: Apply limit (leads assumed ranked best-first by web search)
  const leadsToProcess = allLeads.slice(0, limit);
  result.limitExceeded = Math.max(0, allLeads.length - limit);

  // Step 3: Process each lead
  for (const lead of leadsToProcess) {
    try {
      // Duplicate check — O(1) lookup against master. Handles URL variations
      // (https↔http, www↔no-www, trailing-slash, query-string) via normalization.
      const normScanned = normalizeLinkedInUrl(lead.profileUrl);

      if (normScanned && seenUrls.has(normScanned)) {
        console.log(`Skipped: ${lead.firstName} ${lead.lastName} — already in GojiBerry`);
        result.skipped.push(lead);
        continue;
      }

      // Create lead
      await client.createLead(buildCreateLeadInput(lead));

      // Track within this run so two web-search results pointing at the same
      // profile don't both get created.
      if (normScanned) seenUrls.add(normScanned);
      result.created.push(lead);
    } catch (err: unknown) {
      if (err instanceof AuthError) {
        console.error(err.message);
        throw err;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `Failed to create lead: ${lead.firstName} ${lead.lastName} — ${errorMessage}`,
      );
      result.failed.push({ lead, error: errorMessage });
    }
  }

  // Step 4: Output summary
  outputSummary(result, limit);

  return result;
}
