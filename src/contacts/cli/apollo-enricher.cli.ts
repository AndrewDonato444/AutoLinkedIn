import path from 'path';
import { enrichContacts } from '../apollo-enricher.js';
import type { ApolloClient, ApolloMatchInput, ApolloMatchResult } from '../types.js';

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function flagValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

/**
 * Stub ApolloClient — not wired until user confirms credentials + credit budget.
 * Keeps the CLI runnable in --dry-run mode for safe local testing.
 */
function makeStubApollo(): ApolloClient {
  return {
    async peopleMatch(_input: ApolloMatchInput): Promise<ApolloMatchResult> {
      throw new Error('Apollo client not wired — refusing to spend credits without explicit wiring. See src/contacts/cli/apollo-enricher.cli.ts');
    },
    async peopleBulkMatch(_inputs: ApolloMatchInput[]): Promise<ApolloMatchResult[]> {
      throw new Error('Apollo client not wired — refusing to spend credits without explicit wiring. See src/contacts/cli/apollo-enricher.cli.ts');
    },
  };
}

async function main(): Promise<void> {
  if (hasFlag('help')) {
    console.log('Usage: apollo-enricher [--apply] [--limit N]');
    console.log('');
    console.log('DEFAULT is dry run — no Apollo calls made, no credits spent.');
    console.log('Use --apply to actually call Apollo.');
    console.log('Use --limit N to cap the number of contacts considered.');
    console.log('');
    console.log('Env:');
    console.log('  APOLLO_RUN_BUDGET    (default 50)   Hard cap per run');
    console.log('  APOLLO_TOTAL_BUDGET  (default 500)  Absolute cap across all runs');
    return;
  }

  const masterFilePath = path.join(process.cwd(), 'data', 'contacts.jsonl');
  const logFilePath = path.join(process.cwd(), 'data', 'apollo-enrichment-log.jsonl');
  const apply = hasFlag('apply');
  const limit = flagValue('limit') ? Number(flagValue('limit')) : undefined;
  const runBudget = Number(process.env.APOLLO_RUN_BUDGET ?? '50');
  const totalBudget = Number(process.env.APOLLO_TOTAL_BUDGET ?? '500');

  const apollo = makeStubApollo();

  console.log(`=== Apollo Enrichment — ${apply ? 'APPLY' : 'DRY RUN'} ===`);
  console.log('');
  const result = await enrichContacts({
    masterFilePath,
    logFilePath,
    _apollo: apollo,
    apply,
    runBudget,
    totalBudget,
    limit,
  });

  console.log('Gate check:');
  for (const [gate, count] of Object.entries(result.skippedByGate)) {
    console.log(`  skipped (${gate}): ${count}`);
  }
  console.log(`  eligible: ${result.eligible}`);
  console.log('');
  console.log(`Budget:`);
  console.log(`  APOLLO_RUN_BUDGET: ${runBudget}`);
  console.log(`  APOLLO_TOTAL_BUDGET: ${totalBudget}`);
  console.log(`  Projected credits this run: ${result.projectedCredits}`);
  console.log('');
  if (apply) {
    console.log(`Results:`);
    console.log(`  enriched: ${result.enriched}`);
    console.log(`  credits used: ${result.creditsUsed}`);
    for (const [outcome, count] of Object.entries(result.outcomes)) {
      console.log(`  ${outcome}: ${count}`);
    }
  } else {
    console.log('To proceed, re-run with --apply.');
  }
  if (result.warnings.length > 0) {
    console.log('');
    console.log(`WARNINGS: ${result.warnings.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
