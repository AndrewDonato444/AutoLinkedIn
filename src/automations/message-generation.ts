import dotenv from 'dotenv';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { GojiBerryClient } from '../api/gojiberry-client.js';
import { AuthError, ConfigError } from '../api/errors.js';
import type { Lead } from '../api/types.js';
import type { MessageGenerationResult, MessageGeneratorFn } from './types.js';
import { resolvePositiveNumber } from './lead-enrichment.js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const DEFAULT_MIN_INTENT_SCORE = 50;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_LENGTH = 300;
const DEFAULT_TONE = 'casual';
const ANTHROPIC_MODEL = 'claude-opus-4-6';
const MESSAGE_PREVIEW_LENGTH = 80;
const SUMMARY_SEPARATOR_WIDTH = 80;
// Fetch more warm leads than batchSize to account for client-side filtering
const FETCH_PAGE_SIZE = 500;

type MessageGenClient = Pick<GojiBerryClient, 'searchLeads' | 'getLead' | 'updateLead'>;

export interface GenerateMessagesOptions {
  leadId?: string;
  forceRegenerate?: boolean;
  batchSize?: number;
  minIntentScore?: number;
  icpDescription?: string;
  tone?: string;
  maxLength?: number;
  /** Test-only: inject mock message generator */
  _messageGenerator?: MessageGeneratorFn;
  /** Test-only: inject mock GojiBerry client */
  _client?: MessageGenClient;
}

function buildMessagePrompt(
  lead: Lead,
  icpDescription: string,
  options: { tone: string; maxLength: number },
): string {
  const signals = (lead.intentSignals ?? []).join('\n- ');
  return `Write a personalized LinkedIn connection request message for this person.

Person: ${lead.firstName} ${lead.lastName}
Job Title: ${lead.jobTitle ?? 'Unknown'}
Company: ${lead.company ?? 'Unknown'}
Buying Signals:
- ${signals || 'No specific signals available'}

ICP Context: ${icpDescription}
Tone: ${options.tone}
Max length: ${options.maxLength} characters

Requirements:
- Reference at least one specific buying signal (not generic platitudes)
- Connect the signal to a relevant value proposition
- Sound like a real human wrote this after actually reading their profile
- Do NOT use: "I noticed we're both in [industry]", "I came across your profile", or other template phrases
- Keep it under ${options.maxLength} characters (hard limit — do not exceed)
- Write only the message text, nothing else`;
}

function enforceMaxLength(message: string, maxLength: number): string {
  if (message.length <= maxLength) return message;
  const truncated = message.slice(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('.');
  return lastPeriod > maxLength * 0.5 ? message.slice(0, lastPeriod + 1) : truncated;
}

export async function defaultMessageGenerator(
  lead: Lead,
  icpDescription: string,
  options: { tone: string; maxLength: number },
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      'Missing ANTHROPIC_API_KEY in .env.local — required for message generation',
    );
  }

  const anthropic = new Anthropic({ apiKey });
  const prompt = buildMessagePrompt(lead, icpDescription, options);

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Anthropic returned no text content');
  }

  return enforceMaxLength(textBlock.text.trim(), options.maxLength);
}

function outputMessageSummary(result: MessageGenerationResult): void {
  const { generated, failed, remaining } = result;

  if (generated.length === 0 && failed.length === 0) return;

  // Summary table sorted by fitScore descending
  if (generated.length > 0) {
    console.log('\nMessage Generation Summary:');
    console.log('─'.repeat(SUMMARY_SEPARATOR_WIDTH));
    const sorted = [...generated].sort(
      (a, b) => (b.lead.fitScore ?? 0) - (a.lead.fitScore ?? 0),
    );
    for (const { lead, message } of sorted) {
      const parts: string[] = [
        `${lead.firstName} ${lead.lastName}`,
        lead.company ?? '—',
        `score: ${lead.fitScore ?? '—'}`,
        message.slice(0, MESSAGE_PREVIEW_LENGTH),
      ];
      console.log(parts.join(' | '));
    }
    console.log('─'.repeat(SUMMARY_SEPARATOR_WIDTH));
  }

  // Totals line
  if (remaining > 0 && failed.length === 0) {
    console.log(
      `${generated.length} messages generated (${remaining} remaining — run again to continue)`,
    );
  } else if (failed.length > 0) {
    const parts: string[] = [`${generated.length} messages generated`];
    parts.push(`${failed.length} failed (see logs)`);
    if (remaining > 0) parts.push(`${remaining} remaining — run again to continue`);
    console.log(parts.join(', '));
  } else {
    console.log(`${generated.length} messages generated — ready for review in GojiBerry`);
  }
}

export async function generateMessages(
  options: GenerateMessagesOptions = {},
): Promise<MessageGenerationResult> {
  const icpDescription = options.icpDescription ?? process.env.ICP_DESCRIPTION;

  if (!icpDescription || icpDescription.trim() === '') {
    throw new ConfigError(
      'Missing ICP_DESCRIPTION in .env.local — describe your ideal customer first',
    );
  }

  const minIntentScore = resolvePositiveNumber(
    options.minIntentScore,
    'MIN_INTENT_SCORE',
    DEFAULT_MIN_INTENT_SCORE,
  );
  const batchSize = resolvePositiveNumber(
    options.batchSize,
    'MESSAGE_BATCH_SIZE',
    DEFAULT_BATCH_SIZE,
  );
  const maxLength = resolvePositiveNumber(
    options.maxLength,
    'MESSAGE_MAX_LENGTH',
    DEFAULT_MAX_LENGTH,
  );
  const tone = options.tone ?? process.env.MESSAGE_TONE ?? DEFAULT_TONE;

  const client: MessageGenClient = options._client ?? new GojiBerryClient();
  const messageGenerator: MessageGeneratorFn =
    options._messageGenerator ?? defaultMessageGenerator;

  const result: MessageGenerationResult = {
    generated: [],
    failed: [],
    skipped: [],
    remaining: 0,
  };

  // ── Single-lead mode ──────────────────────────────────────────────────────
  if (options.leadId) {
    const lead = await client.getLead(options.leadId);

    if (lead.fit !== 'qualified') {
      throw new Error(
        `Lead ${lead.firstName} ${lead.lastName} is not qualified — enrich first`,
      );
    }

    const message = await messageGenerator(lead, icpDescription, { tone, maxLength });
    await client.updateLead(lead.id, { personalizedMessages: [{ content: message, stepNumber: 1 }] } as any);
    result.generated.push({ lead, message });

    console.log(
      `${lead.firstName} ${lead.lastName} — message ready: ${message.slice(0, MESSAGE_PREVIEW_LENGTH)}`,
    );
    return result;
  }

  // ── Batch mode ────────────────────────────────────────────────────────────
  const page = await client.searchLeads({ scoreFrom: minIntentScore, pageSize: FETCH_PAGE_SIZE });

  // Partition: leads already messaged → skipped
  const alreadyMessaged = page.leads.filter(
    (l) => !options.forceRegenerate && (l.personalizedMessages?.length ?? 0) > 0,
  );
  result.skipped.push(...alreadyMessaged);

  // Eligible: qualified fit, no messages yet (or forceRegenerate), has profileBaseline signals
  const eligible = page.leads
    .filter((l) => l.fit === 'qualified')
    .filter((l) => options.forceRegenerate || !(l.personalizedMessages?.length))
    .filter((l) => !!l.profileBaseline);

  const toProcess = eligible.slice(0, batchSize);
  result.remaining = eligible.length - toProcess.length;

  for (const lead of toProcess) {
    // Low-signal warning: minimal profileBaseline
    if ((lead.profileBaseline?.length ?? 0) < 50) {
      console.log(
        `Low signal: ${lead.firstName} ${lead.lastName} — message generated from limited data`,
      );
    }

    // Generate message
    let message: string;
    try {
      message = await messageGenerator(lead, icpDescription, { tone, maxLength });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `Failed to generate message for: ${lead.firstName} ${lead.lastName} — ${errorMessage}`,
      );
      result.failed.push({ lead, error: errorMessage });
      continue;
    }

    // Store message
    try {
      await client.updateLead(lead.id, { personalizedMessages: [{ content: message, stepNumber: 1 }] } as any);
      result.generated.push({ lead, message });

      if (options.forceRegenerate) {
        console.log(`Regenerated: ${lead.firstName} ${lead.lastName}`);
      }
    } catch (err: unknown) {
      if (err instanceof AuthError) {
        console.error(err.message);
        throw err;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `Failed to save message for: ${lead.firstName} ${lead.lastName} — ${errorMessage}`,
      );
      result.failed.push({ lead, error: errorMessage });
    }
  }

  outputMessageSummary(result);
  return result;
}
