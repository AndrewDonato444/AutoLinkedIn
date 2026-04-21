import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { applyMessages } from '../regenerate.js';
import type { RegenPlan, RegenResult } from '../regenerate.js';
import { GojiBerryClient } from '../../api/gojiberry-client.js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function flagValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

async function main(): Promise<void> {
  if (hasFlag('help')) {
    console.log('Usage: regen-apply --plan <plan.json> --messages <results.json> [--dry-run]');
    console.log('');
    console.log('Writes Claude-generated messages to GojiBerry via updateLead.');
    console.log('');
    console.log('Required:');
    console.log('  --plan <path>      Plan JSON written by regen-plan');
    console.log('  --messages <path>  JSON array of { contactId, message }');
    console.log('');
    console.log('Optional:');
    console.log('  --dry-run          Print what would be written; no GojiBerry writes');
    return;
  }

  const planPath = flagValue('plan');
  const messagesPath = flagValue('messages');
  if (!planPath || !messagesPath) {
    console.error('Error: --plan and --messages are required');
    process.exit(1);
  }

  const plan: RegenPlan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const results: RegenResult[] = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));

  if (hasFlag('dry-run')) {
    console.log('=== DRY RUN — nothing written ===');
    console.log(`plan runId: ${plan.runId}`);
    console.log(`results: ${results.length}`);
    const planIds = new Set(plan.candidates.map((c) => c.id));
    const orphans = results.filter((r) => !planIds.has(r.contactId));
    if (orphans.length > 0) {
      console.log(`WARNING: ${orphans.length} results not in plan will be skipped:`);
      for (const o of orphans.slice(0, 5)) console.log(`  id=${o.contactId}`);
    }
    console.log('\nSample (first 3):');
    for (const r of results.slice(0, 3)) {
      const c = plan.candidates.find((x) => x.id === r.contactId);
      console.log(`  ${r.contactId} | ${c?.firstName} ${c?.lastName} → ${r.message.slice(0, 80)}...`);
    }
    return;
  }

  const client = new GojiBerryClient();
  const summary = await applyMessages({ plan, results, _client: client });

  console.log('=== Regen Apply — Summary ===');
  console.log(`written: ${summary.written}`);
  console.log(`skipped: ${summary.skipped}`);
  console.log(`failed:  ${summary.failed.length}`);
  if (summary.failed.length > 0) {
    console.log('');
    console.log('Failures:');
    for (const f of summary.failed) console.log(`  ${f.contactId}: ${f.error}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
