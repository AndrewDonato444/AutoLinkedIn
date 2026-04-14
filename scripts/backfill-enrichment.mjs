/**
 * backfill-enrichment.mjs
 * Re-pushes scores, signals, and messages from a scan log to GojiBerry
 * using the correct API field formats.
 *
 * Usage: node scripts/backfill-enrichment.mjs [path-to-scan-log.json]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.local
const envPath = path.join(__dirname, '..', '.env.local');
const env = fs.readFileSync(envPath, 'utf8');
for (const line of env.split('\n')) {
  const [key, ...rest] = line.split('=');
  if (key && rest.length && !key.startsWith('#')) {
    process.env[key.trim()] = rest.join('=').trim().replace(/^"|"$/g, '');
  }
}

const API_KEY = process.env.GOJIBERRY_API_KEY;
const API_URL = process.env.GOJIBERRY_API_URL || 'https://ext.gojiberry.ai';
const MIN_INTENT_SCORE = Number(process.env.MIN_INTENT_SCORE || 60);

if (!API_KEY) {
  console.error('Missing GOJIBERRY_API_KEY in .env.local');
  process.exit(1);
}

// Load scan log
const logPath = process.argv[2] || path.join(__dirname, '..', 'data', 'scan-logs', 'scan-2026-04-13.json');
const scanLog = JSON.parse(fs.readFileSync(logPath, 'utf8'));
const contacts = scanLog.contacts || [];

console.log(`Backfilling ${contacts.length} contacts from ${path.basename(logPath)}\n`);

let updated = 0;
let skipped = 0;
let failed = 0;

for (const contact of contacts) {
  const { id, name, score, message } = contact;

  if (!id) {
    console.log(`Skipped — no ID: ${name}`);
    skipped++;
    continue;
  }

  // Build the correct payload
  const fit = score >= MIN_INTENT_SCORE ? 'qualified' : 'unknown';

  // Build profileBaseline from available data
  const signals = contact.signals || [];
  const profileBaselineParts = [`ICP Score: ${score}/100`];
  if (contact.reason) profileBaselineParts.push(`Reasoning: ${contact.reason}`);
  if (signals.length > 0) profileBaselineParts.push(`Signals: ${signals.join(' | ')}`);
  const profileBaseline = profileBaselineParts.join('\n');

  try {
    // Step 1: Update fit + profileBaseline
    const enrichRes = await fetch(`${API_URL}/v1/contact/${id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fit, profileBaseline }),
    });

    if (!enrichRes.ok) {
      const text = await enrichRes.text();
      throw new Error(`${enrichRes.status} ${enrichRes.statusText}: ${text}`);
    }

    // Step 2: Update personalizedMessages if we have a message
    if (message) {
      const msgRes = await fetch(`${API_URL}/v1/contact/${id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizedMessages: [{ content: message, stepNumber: 1 }],
        }),
      });

      if (!msgRes.ok) {
        const text = await msgRes.text();
        throw new Error(`Message save failed: ${msgRes.status}: ${text}`);
      }
    }

    const msgStatus = message ? '+ message' : '(no message — below threshold)';
    console.log(`✓ ${name} — ${fit} (${score}) ${msgStatus}`);
    updated++;

    // Rate limit: 100 req/min = ~600ms between pairs of calls
    await new Promise(r => setTimeout(r, 700));

  } catch (err) {
    console.error(`✗ ${name} (id: ${id}) — ${err.message}`);
    failed++;
  }
}

console.log(`\nDone: ${updated} updated, ${skipped} skipped, ${failed} failed`);
