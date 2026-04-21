import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { planRegeneration } from '../regenerate.js';

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
    console.log('Usage: regen-plan [--limit N] [--list-id N] [--force] [--contains TOKEN[,TOKEN...]]');
    console.log('');
    console.log('Builds a message-regeneration plan: filters master contacts and writes');
    console.log('the candidates to data/regen-plans/<runId>.json.');
    console.log('');
    console.log('--limit N           Cap number of candidates (sorted by ICP score desc)');
    console.log('--list-id N         Only regenerate for contacts in this GojiBerry list');
    console.log('--force             Include contacts that already have a message (overwrite)');
    console.log('--contains TOKENS   Only queue contacts whose current message contains one of');
    console.log('                    these comma-separated case-insensitive tokens (implies --force).');
    console.log('                    e.g. --contains gojiberry   for surgical hallucination fixes');
    console.log('');
    console.log('Gates (always applied):');
    console.log('  - Skip contacts with fit != "qualified"');
    console.log('  - Skip contacts with empty intentSignals (would generate generic message)');
    console.log('  - Skip contacts where step-1 message has already been sent');
    return;
  }

  const masterFilePath = path.join(process.cwd(), 'data', 'contacts.jsonl');
  const listId = flagValue('list-id') ? Number(flagValue('list-id')) : undefined;
  const limit = flagValue('limit') ? Number(flagValue('limit')) : undefined;
  const force = hasFlag('force');
  const containsTokens = flagValue('contains')?.split(',').map((t) => t.trim()).filter(Boolean);

  const plan = await planRegeneration({ masterFilePath, listId, limit, force, containsTokens });

  const plansDir = path.join(process.cwd(), 'data', 'regen-plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const planFile = path.join(plansDir, `${plan.runId}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

  console.error('=== Message Regeneration Plan ===');
  console.error(`runId: ${plan.runId}`);
  console.error('');
  console.error('Gates:');
  for (const [gate, count] of Object.entries(plan.skippedByGate)) {
    console.error(`  skipped (${gate}): ${count}`);
  }
  console.error(`  eligible: ${plan.eligible}`);
  console.error('');
  if (plan.candidates.length > 0) {
    console.error('Top 5 candidates:');
    for (const c of plan.candidates.slice(0, 5)) {
      console.error(`  ${c.id} | ${c.firstName} ${c.lastName} @ ${c.company} (ICP: ${c.icpScore})`);
    }
  }

  console.log(planFile);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
