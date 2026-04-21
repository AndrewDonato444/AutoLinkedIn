import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  applyEnrichmentResults,
  correlateApolloResponse,
} from '../apollo-enricher.js';
import type {
  ApolloRawBulkResponse,
  EnrichmentPlan,
  EnrichmentResult,
} from '../apollo-enricher.js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

function flagValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? undefined : process.argv[idx + 1];
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { body += chunk; });
    process.stdin.on('end', () => resolve(body));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  if (hasFlag('help')) {
    console.log('Usage: apollo-apply --plan <plan.json> (--mcp-response <file> | --results <file>)');
    console.log('');
    console.log('Applies Apollo enrichment outcomes to the master contact store.');
    console.log('');
    console.log('Required:');
    console.log('  --plan <path>            Plan JSON (written by apollo-plan)');
    console.log('');
    console.log('One of:');
    console.log('  --mcp-response <path>    Raw Apollo bulk_match response(s).');
    console.log('                           Either one response object, or an array');
    console.log('                           of responses (one per batch). Correlation');
    console.log('                           by normalized LinkedIn URL happens here.');
    console.log('  --results <path>         Pre-correlated EnrichmentResult[] JSON');
    console.log('                           (legacy; use --mcp-response when possible).');
    console.log('');
    console.log('If neither --mcp-response nor --results is given, reads from stdin');
    console.log('and auto-detects format (presence of "matches" field → MCP response).');
    return;
  }

  const planPath = flagValue('plan');
  if (!planPath) {
    console.error('Error: --plan <path> is required');
    process.exit(1);
  }
  const plan: EnrichmentPlan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

  let results: EnrichmentResult[];

  const mcpPath = flagValue('mcp-response');
  const resultsPath = flagValue('results');

  if (mcpPath) {
    const raw = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    results = correlateFromRaw(plan, raw);
  } else if (resultsPath) {
    results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  } else {
    const body = JSON.parse(await readStdin());
    if (Array.isArray(body) && body.length > 0 && 'contactId' in body[0]) {
      results = body as EnrichmentResult[];
    } else {
      results = correlateFromRaw(plan, body);
    }
  }

  const summary = await applyEnrichmentResults(plan, results);
  console.log('=== Apollo Apply — Summary ===');
  console.log(`enriched: ${summary.enriched}`);
  console.log(`credits used: ${summary.creditsUsed}`);
  console.log('');
  console.log('Outcomes:');
  for (const [outcome, count] of Object.entries(summary.outcomes)) {
    console.log(`  ${outcome}: ${count}`);
  }
  if (summary.warnings.length > 0) {
    console.log('');
    console.log(`WARNINGS: ${summary.warnings.join(', ')}`);
  }
}

function correlateFromRaw(plan: EnrichmentPlan, raw: ApolloRawBulkResponse | ApolloRawBulkResponse[]): EnrichmentResult[] {
  const responses = Array.isArray(raw) ? raw : [raw];
  const merged: ApolloRawBulkResponse = {
    matches: responses.flatMap((r) => r.matches ?? []),
  };
  return correlateApolloResponse(plan, merged);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
