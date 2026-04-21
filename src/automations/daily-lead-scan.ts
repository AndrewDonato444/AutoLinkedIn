import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { discoverLeads } from './icp-lead-discovery.js';
import { enrichLeads } from './lead-enrichment.js';
import { generateMessages } from './message-generation.js';
import { rebuildMaster } from '../contacts/rebuild-master.js';
import { AuthError } from '../api/errors.js';
import type { DiscoveryResult, EnrichmentResult, MessageGenerationResult } from './types.js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const DEFAULT_LEAD_LIMIT = 10;
const DEFAULT_MIN_INTENT_SCORE = 50;
const DEFAULT_CRON = '0 7 * * 1-5';
const DEFAULT_SCAN_LOG_DIR = 'data/scan-logs';
const DEFAULT_MASTER_PATH = 'data/contacts.jsonl';
const AUTH_ABORT_MSG =
  'Daily scan aborted — API authentication failed. Check your GOJIBERRY_API_KEY.';

export interface DailyScanOptions {
  /** Override ICP_DESCRIPTION from env */
  icpDescription?: string;
  /** Override DAILY_LEAD_SCAN_LIMIT from env */
  leadLimit?: number;
  /** Override MIN_INTENT_SCORE from env */
  minIntentScore?: number;
  /** Override MESSAGE_TONE from env */
  messageTone?: string;
  /** Override MESSAGE_MAX_LENGTH from env */
  messageMaxLength?: number;
  /** Test-only: inject mock discovery function */
  _discoverLeads?: typeof discoverLeads;
  /** Test-only: inject mock enrichment function */
  _enrichLeads?: typeof enrichLeads;
  /** Test-only: inject mock message generation function */
  _generateMessages?: typeof generateMessages;
  /** Test-only: inject mock master rebuild function */
  _rebuildMaster?: typeof rebuildMaster;
  /** Test-only: override scan log directory */
  _scanLogDir?: string;
  /** Test-only: override master file path (default: data/contacts.jsonl) */
  _masterFilePath?: string;
}

export interface DailyScanResult {
  date: string;
  discovery: DiscoveryResult;
  enrichment: EnrichmentResult | null;
  messageGeneration: MessageGenerationResult | null;
  aboveThreshold: number;
  belowThreshold: number;
  failures: { lead: string; stage: 'discovery' | 'enrichment' | 'messages'; error: string }[];
  nextAction: string;
  durationMs: number;
  summaryText: string;
}

function resolveLimit(
  optionValue: number | undefined,
  envKey: string,
  defaultValue: number,
): number {
  const raw = optionValue ?? Number(process.env[envKey] ?? defaultValue);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultValue;
}

function nextScanLabel(cron: string): string {
  if (cron === DEFAULT_CRON) return 'Tomorrow (weekdays at 7am)';
  return `Next run per cron: ${cron}`;
}

function buildFailures(
  discovery: DiscoveryResult,
  enrichment: EnrichmentResult | null,
  messages: MessageGenerationResult | null,
): DailyScanResult['failures'] {
  const failures: DailyScanResult['failures'] = [];

  for (const f of discovery.failed) {
    failures.push({
      lead: `${f.lead.firstName} ${f.lead.lastName}`,
      stage: 'discovery',
      error: f.error,
    });
  }

  if (enrichment) {
    for (const f of enrichment.failed) {
      failures.push({
        lead: `${f.lead.firstName} ${f.lead.lastName}`,
        stage: 'enrichment',
        error: f.error,
      });
    }
  }

  if (messages) {
    for (const f of messages.failed) {
      failures.push({
        lead: `${f.lead.firstName} ${f.lead.lastName}`,
        stage: 'messages',
        error: f.error,
      });
    }
  }

  return failures;
}

function determineNextAction(
  discovery: DiscoveryResult,
  aboveThreshold: number,
  failures: DailyScanResult['failures'],
  messageGeneration: MessageGenerationResult | null,
): string {
  if (discovery.created.length === 0) {
    return 'This can happen when your ICP is very specific — consider broadening it';
  }
  if (failures.length > 0) {
    return 'Some leads had errors — review failures above and re-run if needed';
  }
  if (messageGeneration && messageGeneration.generated.length > 0) {
    return `Open GojiBerry to review and approve ${messageGeneration.generated.length} new messages`;
  }
  if (aboveThreshold === 0) {
    return 'Consider broadening your ICP or lowering the intent threshold';
  }
  return 'Open GojiBerry to review new leads';
}

function buildDiscoveryLine(discovery: DiscoveryResult, leadLimit: number): string {
  const { created, skipped, limitExceeded } = discovery;

  if (created.length === 0 && skipped.length === 0) {
    return 'Discovery: No new leads found matching your ICP today';
  }

  let line = `Discovery: ${created.length} new leads found, ${skipped.length} skipped (duplicates)`;
  if (limitExceeded > 0) {
    line += `\n           (limit: ${leadLimit})`;
  }
  return line;
}

function buildEnrichmentLine(
  enrichment: EnrichmentResult | null,
  aboveThreshold: number,
  belowThreshold: number,
  minIntentScore: number,
): string {
  if (!enrichment) {
    return 'Enrichment: Skipped — no leads to enrich';
  }

  const { enriched, failed } = enrichment;
  let line = `Enrichment: ${enriched.length} leads enriched, ${failed.length} failed`;
  line += `\n            ${aboveThreshold} above intent threshold (${minIntentScore}+)`;
  line += `\n            ${belowThreshold} below threshold`;
  return line;
}

function buildMessagesLine(
  messageGeneration: MessageGenerationResult | null,
  aboveThreshold: number,
): string {
  if (!messageGeneration) {
    if (aboveThreshold === 0) {
      return 'Messages: Skipped — no leads above intent threshold';
    }
    return 'Messages: Skipped — no leads to enrich';
  }

  const { generated, failed } = messageGeneration;
  return `Messages: ${generated.length} messages generated, ${failed.length} failed`;
}

function buildFailuresSection(failures: DailyScanResult['failures']): string {
  if (failures.length === 0) {
    return '--- Failures ---\n  None';
  }

  const lines = ['--- Failures ---'];
  for (const f of failures) {
    lines.push(`  - ${f.lead}: ${f.error}`);
  }
  return lines.join('\n');
}

function buildSummaryText(
  date: string,
  discovery: DiscoveryResult,
  enrichment: EnrichmentResult | null,
  messageGeneration: MessageGenerationResult | null,
  aboveThreshold: number,
  belowThreshold: number,
  leadLimit: number,
  minIntentScore: number,
  failures: DailyScanResult['failures'],
  nextAction: string,
  durationMs: number,
  cron: string,
): string {
  const discovered = discovery.created.length;
  const enriched = enrichment?.enriched.length ?? 0;
  const messaged = messageGeneration?.generated.length ?? 0;
  const durationSec = (durationMs / 1000).toFixed(1);

  const sections: string[] = [
    `=== Daily Lead Scan (${date}) ===`,
    '',
    buildDiscoveryLine(discovery, leadLimit),
    '',
    buildEnrichmentLine(enrichment, aboveThreshold, belowThreshold, minIntentScore),
    '',
    buildMessagesLine(messageGeneration, aboveThreshold),
    '',
    buildFailuresSection(failures),
    '',
    '--- Summary ---',
    `  Pipeline: ${discovered} → ${enriched} → ${messaged} messages ready`,
    `  ${nextAction}`,
    `  Duration: ${durationSec}s`,
    '',
    `Next scan: ${nextScanLabel(cron)}`,
  ];

  return sections.join('\n');
}

async function saveScanLog(result: DailyScanResult, scanLogDir: string): Promise<void> {
  // Exclude summaryText from machine-readable log
  const { summaryText: _summaryText, ...logData } = result;
  const logPath = path.join(scanLogDir, `${result.date}.json`);

  await fs.promises.mkdir(scanLogDir, { recursive: true });
  await fs.promises.writeFile(logPath, JSON.stringify(logData, null, 2), 'utf-8');
}

function makeEmptyDiscovery(): DiscoveryResult {
  return { created: [], skipped: [], failed: [], limitExceeded: 0 };
}

export async function runDailyLeadScan(
  options: DailyScanOptions = {},
): Promise<DailyScanResult> {
  const startTime = Date.now();
  const date = new Date().toISOString().slice(0, 10);

  const icpDescription = options.icpDescription ?? process.env.ICP_DESCRIPTION;
  const leadLimit = resolveLimit(options.leadLimit, 'DAILY_LEAD_SCAN_LIMIT', DEFAULT_LEAD_LIMIT);
  const minIntentScore = resolveLimit(
    options.minIntentScore,
    'MIN_INTENT_SCORE',
    DEFAULT_MIN_INTENT_SCORE,
  );
  const messageTone = options.messageTone ?? process.env.MESSAGE_TONE;
  const messageMaxLengthRaw =
    options.messageMaxLength ?? Number(process.env.MESSAGE_MAX_LENGTH ?? 0);
  const messageMaxLength = messageMaxLengthRaw > 0 ? messageMaxLengthRaw : undefined;
  const scanLogDir = options._scanLogDir ?? DEFAULT_SCAN_LOG_DIR;
  const cron = process.env.DAILY_SCAN_CRON ?? DEFAULT_CRON;

  const discoverFn = options._discoverLeads ?? discoverLeads;
  const enrichFn = options._enrichLeads ?? enrichLeads;
  const generateFn = options._generateMessages ?? generateMessages;
  const rebuildFn = options._rebuildMaster ?? rebuildMaster;
  const masterFilePath = options._masterFilePath ?? DEFAULT_MASTER_PATH;

  /** Build, save, and return an abort result where nextAction === summaryText. */
  const abort = async (
    msg: string,
    discovery: DiscoveryResult,
    enrichment: EnrichmentResult | null,
    aboveThreshold: number,
    belowThreshold: number,
    failures: DailyScanResult['failures'],
    logFn: (m: string) => void = console.error,
  ): Promise<DailyScanResult> => {
    logFn(msg);
    const result: DailyScanResult = {
      date,
      discovery,
      enrichment,
      messageGeneration: null,
      aboveThreshold,
      belowThreshold,
      failures,
      nextAction: msg,
      durationMs: Date.now() - startTime,
      summaryText: msg,
    };
    await saveScanLog(result, scanLogDir);
    return result;
  };

  // ── Validate ICP ────────────────────────────────────────────────────────────
  if (!icpDescription || icpDescription.trim() === '') {
    const abortMsg =
      'Daily scan aborted — ICP_DESCRIPTION is required. Define your ideal customer to start scanning.';
    return abort(abortMsg, makeEmptyDiscovery(), null, 0, 0, [], console.log);
  }

  // ── Step 0: Refresh master so dedup is accurate ─────────────────────────────
  // Discovery dedups against the master contact store; we rebuild here to pull
  // the latest GojiBerry state before each scan. AuthError aborts. Other errors
  // are logged but non-fatal — we'd rather run with slightly stale master than
  // skip the scan entirely. Reuses `scanLogDir` (already resolved from options
  // or default) so a test override flows through.
  try {
    await rebuildFn({ masterFilePath, scanLogsDir: scanLogDir });
  } catch (err: unknown) {
    if (err instanceof AuthError) {
      return abort(AUTH_ABORT_MSG, makeEmptyDiscovery(), null, 0, 0, []);
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn(`Master rebuild failed (continuing with existing master): ${errorMessage}`);
  }

  // ── Step 1: Discovery ───────────────────────────────────────────────────────
  let discoveryResult: DiscoveryResult;
  try {
    discoveryResult = await discoverFn({
      icpDescription,
      limit: leadLimit,
      masterFilePath,
    });
  } catch (err: unknown) {
    if (err instanceof AuthError) {
      return abort(AUTH_ABORT_MSG, makeEmptyDiscovery(), null, 0, 0, []);
    }

    const errorMessage = err instanceof Error ? err.message : String(err);
    const failMsg = `Daily scan failed at discovery: ${errorMessage}`;
    console.error(failMsg);
    const result: DailyScanResult = {
      date,
      discovery: makeEmptyDiscovery(),
      enrichment: null,
      messageGeneration: null,
      aboveThreshold: 0,
      belowThreshold: 0,
      failures: [],
      nextAction: 'Some leads had errors — review failures above and re-run if needed',
      durationMs: Date.now() - startTime,
      summaryText: failMsg,
    };
    await saveScanLog(result, scanLogDir);
    return result;
  }

  // ── Zero leads case ─────────────────────────────────────────────────────────
  if (discoveryResult.created.length === 0) {
    const nextAction =
      'This can happen when your ICP is very specific — consider broadening it';
    const failures = buildFailures(discoveryResult, null, null);
    const summaryText = buildSummaryText(
      date,
      discoveryResult,
      null,
      null,
      0,
      0,
      leadLimit,
      minIntentScore,
      failures,
      nextAction,
      Date.now() - startTime,
      cron,
    );
    console.log(summaryText);

    const result: DailyScanResult = {
      date,
      discovery: discoveryResult,
      enrichment: null,
      messageGeneration: null,
      aboveThreshold: 0,
      belowThreshold: 0,
      failures,
      nextAction,
      durationMs: Date.now() - startTime,
      summaryText,
    };
    await saveScanLog(result, scanLogDir);
    return result;
  }

  // ── Step 2: Enrichment ──────────────────────────────────────────────────────
  let enrichmentResult: EnrichmentResult;
  try {
    enrichmentResult = await enrichFn({
      icpDescription,
      minIntentScore,
      batchSize: leadLimit,
    });
  } catch (err: unknown) {
    if (err instanceof AuthError) {
      return abort(AUTH_ABORT_MSG, discoveryResult, null, 0, 0, buildFailures(discoveryResult, null, null));
    }
    throw err;
  }

  // Filter by threshold
  const aboveThresholdLeads = enrichmentResult.enriched.filter(
    (e) => e.research.fitScore >= minIntentScore,
  );
  const belowThresholdLeads = enrichmentResult.enriched.filter(
    (e) => e.research.fitScore < minIntentScore,
  );
  const aboveThreshold = aboveThresholdLeads.length;
  const belowThreshold = belowThresholdLeads.length;

  // ── Step 3: Message Generation (only if leads above threshold) ──────────────
  let msgResult: MessageGenerationResult | null = null;
  if (aboveThreshold > 0) {
    try {
      const genOptions: Parameters<typeof generateMessages>[0] = {
        icpDescription,
        minIntentScore,
        ...(messageTone !== undefined && { tone: messageTone }),
        ...(messageMaxLength !== undefined && { maxLength: messageMaxLength }),
      };
      msgResult = await generateFn(genOptions);
    } catch (err: unknown) {
      if (err instanceof AuthError) {
        return abort(AUTH_ABORT_MSG, discoveryResult, enrichmentResult, aboveThreshold, belowThreshold, buildFailures(discoveryResult, enrichmentResult, null));
      }
      throw err;
    }
  }

  // ── Build final result ──────────────────────────────────────────────────────
  const durationMs = Date.now() - startTime;
  const failures = buildFailures(discoveryResult, enrichmentResult, msgResult);
  const nextAction = determineNextAction(discoveryResult, aboveThreshold, failures, msgResult);
  const summaryText = buildSummaryText(
    date,
    discoveryResult,
    enrichmentResult,
    msgResult,
    aboveThreshold,
    belowThreshold,
    leadLimit,
    minIntentScore,
    failures,
    nextAction,
    durationMs,
    cron,
  );

  console.log(summaryText);

  const result: DailyScanResult = {
    date,
    discovery: discoveryResult,
    enrichment: enrichmentResult,
    messageGeneration: msgResult,
    aboveThreshold,
    belowThreshold,
    failures,
    nextAction,
    durationMs,
    summaryText,
  };

  await saveScanLog(result, scanLogDir);
  return result;
}
