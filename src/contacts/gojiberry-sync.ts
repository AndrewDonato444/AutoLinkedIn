import { readMaster, writeMaster } from './master-store.js';
import { NotFoundError } from '../api/errors.js';
import type { Lead } from '../api/types.js';
import type { CampaignEvent, MasterContact } from './types.js';

interface SyncClient {
  getLead(id: string): Promise<Lead>;
}

/**
 * GojiBerry's `campaignStatus` comes back as an array of event objects:
 *   [{ type, state, createdAt, stepNumber }, ...]
 *
 * It can also be null/missing (contact not in a campaign) or — in rare
 * legacy data — a string. We normalize to a CampaignEvent[] always, dropping
 * malformed entries. Extra fields on each event are discarded.
 */
export function normalizeCampaignStatus(raw: unknown): CampaignEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: CampaignEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (
      typeof rec.type === 'string' &&
      typeof rec.state === 'string' &&
      typeof rec.createdAt === 'string' &&
      typeof rec.stepNumber === 'number'
    ) {
      events.push({
        type: rec.type,
        state: rec.state,
        createdAt: rec.createdAt,
        stepNumber: rec.stepNumber,
      });
    }
  }
  return events;
}

export interface SyncOptions {
  masterFilePath: string;
  _client: SyncClient;
}

export interface SyncResult {
  synced: number;
  deleted: number;
  errors: number;
}

export async function syncGojiberryState(options: SyncOptions): Promise<SyncResult> {
  const contacts = await readMaster(options.masterFilePath);
  const now = new Date().toISOString();

  let synced = 0;
  let deleted = 0;
  let errors = 0;

  for (const contact of contacts) {
    try {
      const fresh = (await options._client.getLead(String(contact.id))) as unknown as Record<string, unknown>;
      contact.gojiberryState = {
        listId: typeof fresh.listId === 'number' ? (fresh.listId as number) : null,
        campaignStatus: normalizeCampaignStatus(fresh.campaignStatus),
        readyForCampaign: fresh.readyForCampaign === true,
        bounced: fresh.bounced === true,
        unsubscribed: fresh.unsubscribed === true,
        updatedAt: (fresh.updatedAt as string | null) ?? null,
      };
      contact.masterUpdatedAt = now;
      synced++;
    } catch (err) {
      if (err instanceof NotFoundError) {
        (contact as MasterContact).deletedFromGojiberry = true;
        contact.masterUpdatedAt = now;
        deleted++;
      } else {
        errors++;
      }
    }
  }

  await writeMaster(options.masterFilePath, contacts);
  return { synced, deleted, errors };
}
