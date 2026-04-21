/**
 * Writes synthesized profileBaseline strings to GojiBerry via PATCH for each
 * contact in data/reenrichment/synthesized.json.
 *
 * Usage:
 *   node scripts/apply-reenrichment.mjs --dry-run   # preview only
 *   node scripts/apply-reenrichment.mjs --apply     # actually PATCH
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const KEY = process.env.GOJIBERRY_API_KEY;
const URL = process.env.GOJIBERRY_API_URL || process.env.GOJIBERRY_BASE_URL || 'https://ext.gojiberry.ai';
if (!KEY) {
  console.error('Missing GOJIBERRY_API_KEY');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const dryRun = !apply;

const synthesized = JSON.parse(fs.readFileSync('data/reenrichment/synthesized.json', 'utf8'));

console.log(`=== ${dryRun ? 'DRY RUN' : 'APPLY'} — re-enrichment of ${synthesized.length} contacts ===\n`);

if (dryRun) {
  console.log('Sample (first 3):');
  for (const r of synthesized.slice(0, 3)) {
    console.log(`--- ${r.id} | ${r.firstName} ${r.lastName} | synthesized from: ${r.synthesizedFrom} ---`);
    console.log(r.profileBaseline);
  }
  console.log('Re-run with --apply to PATCH GojiBerry.');
  process.exit(0);
}

let written = 0;
const failed = [];
for (const r of synthesized) {
  try {
    const res = await fetch(`${URL}/v1/contact/${r.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ profileBaseline: r.profileBaseline }),
    });
    if (!res.ok) {
      failed.push({ id: r.id, name: `${r.firstName} ${r.lastName}`, status: res.status, msg: await res.text() });
      continue;
    }
    written++;
    if (written % 10 === 0) console.log(`  ...${written} written`);
  } catch (err) {
    failed.push({ id: r.id, name: `${r.firstName} ${r.lastName}`, msg: err.message });
  }
}

console.log(`\nWritten: ${written}`);
console.log(`Failed: ${failed.length}`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  ${f.id} ${f.name}: ${f.status || ''} ${f.msg?.slice(0, 120) || ''}`);
}
