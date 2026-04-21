import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { planEnrichment } from '../apollo-enricher.js';

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
    console.log('Usage: apollo-plan [--limit N]');
    console.log('');
    console.log('Builds an enrichment plan: filters master contacts through all');
    console.log('safeguards (3 gates + 2 budget caps), batches eligible contacts');
    console.log('into groups of 10, and writes the plan to data/apollo-plans/.');
    console.log('');
    console.log('Output: path to the plan JSON file (on stdout\'s last line).');
    console.log('Also prints human-readable summary to stderr.');
    console.log('');
    console.log('Env: APOLLO_RUN_BUDGET (default 50), APOLLO_TOTAL_BUDGET (default 500)');
    return;
  }

  const masterFilePath = path.join(process.cwd(), 'data', 'contacts.jsonl');
  const logFilePath = path.join(process.cwd(), 'data', 'apollo-enrichment-log.jsonl');
  const runBudget = Number(process.env.APOLLO_RUN_BUDGET ?? '50');
  const totalBudget = Number(process.env.APOLLO_TOTAL_BUDGET ?? '500');
  const limit = flagValue('limit') ? Number(flagValue('limit')) : undefined;

  const plan = await planEnrichment({
    masterFilePath,
    logFilePath,
    runBudget,
    totalBudget,
    limit,
  });

  const plansDir = path.join(process.cwd(), 'data', 'apollo-plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const planFile = path.join(plansDir, `${plan.runId}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

  console.error(`=== Apollo Enrichment Plan ===`);
  console.error(`runId: ${plan.runId}`);
  console.error('');
  console.error(`Gate check:`);
  for (const [gate, count] of Object.entries(plan.skippedByGate)) {
    console.error(`  skipped (${gate}): ${count}`);
  }
  console.error(`  eligible: ${plan.eligible}`);
  console.error('');
  console.error(`Budget:`);
  console.error(`  APOLLO_RUN_BUDGET: ${runBudget}`);
  console.error(`  APOLLO_TOTAL_BUDGET: ${totalBudget}`);
  console.error(`  credits already used (from log): ${plan.creditsAlreadyUsed}`);
  console.error(`  remaining headroom: ${plan.budgetRemaining}`);
  console.error('');
  console.error(`This run:`);
  console.error(`  projected credits: ${plan.projectedCredits}`);
  console.error(`  batches: ${plan.batches.length}`);
  if (plan.warnings.length > 0) {
    console.error('');
    console.error(`WARNINGS: ${plan.warnings.join(', ')}`);
  }

  // stdout: just the plan file path, for easy piping
  console.log(planFile);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
