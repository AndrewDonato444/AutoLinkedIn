import path from 'path';
import { rebuildMaster } from '../rebuild-master.js';

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  if (hasFlag('help')) {
    console.log('Usage: rebuild-master [--dry-run]');
    console.log('');
    console.log('Rebuilds data/contacts.jsonl from GojiBerry + data/scan-logs/.');
    console.log('Scan-log reasoning/signals/icpScore override GojiBerry on conflict.');
    console.log('Apollo enrichment fields are preserved across rebuilds.');
    return;
  }

  const masterFilePath = path.join(process.cwd(), 'data', 'contacts.jsonl');
  const scanLogsDir = path.join(process.cwd(), 'data', 'scan-logs');
  const dryRun = hasFlag('dry-run');

  console.log(`${dryRun ? 'DRY RUN — ' : ''}Rebuilding master from GojiBerry + ${scanLogsDir}...`);
  const result = await rebuildMaster({ masterFilePath, scanLogsDir, dryRun });

  console.log(`added:     ${result.added}`);
  console.log(`updated:   ${result.updated}`);
  console.log(`unchanged: ${result.unchanged}`);
  if (dryRun) {
    console.log('');
    console.log('Dry run — no file written. Re-run without --dry-run to apply.');
  } else {
    console.log('');
    console.log(`Wrote ${masterFilePath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
