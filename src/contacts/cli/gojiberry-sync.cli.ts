import path from 'path';
import { GojiBerryClient } from '../../api/gojiberry-client.js';
import { syncGojiberryState } from '../gojiberry-sync.js';

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  if (hasFlag('help')) {
    console.log('Usage: gojiberry-sync');
    console.log('');
    console.log('Pulls fresh GojiBerry engagement state (listId, campaignStatus,');
    console.log('bounced, unsubscribed, readyForCampaign) into data/contacts.jsonl.');
    console.log('Read-only on GojiBerry side; never PATCHes.');
    return;
  }

  const masterFilePath = path.join(process.cwd(), 'data', 'contacts.jsonl');
  const client = new GojiBerryClient();

  console.log(`Syncing GojiBerry state into ${masterFilePath}...`);
  const result = await syncGojiberryState({ masterFilePath, _client: client });
  console.log(`synced:  ${result.synced}`);
  console.log(`deleted: ${result.deleted}`);
  console.log(`errors:  ${result.errors}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
