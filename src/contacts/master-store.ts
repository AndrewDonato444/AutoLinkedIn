import { promises as fs } from 'fs';
import path from 'path';
import type { MasterContact, MasterContactSource } from './types.js';

export async function readMaster(filePath: string): Promise<MasterContact[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const lines = content.split('\n');
  const contacts: MasterContact[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      contacts.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`Malformed JSON on line ${i + 1} of ${filePath}: ${(err as Error).message}`);
    }
  }
  return contacts;
}

export async function writeMaster(filePath: string, contacts: MasterContact[]): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const content = contacts.length === 0 ? '' : contacts.map((c) => JSON.stringify(c)).join('\n') + '\n';
  await fs.writeFile(filePath, content);
}

function dedupeSources(sources: MasterContactSource[]): MasterContactSource[] {
  const seen = new Map<string, MasterContactSource>();
  for (const s of sources) {
    if (!seen.has(s.ref)) seen.set(s.ref, s);
  }
  return Array.from(seen.values());
}

export function mergeContact(
  existing: MasterContact | null,
  incoming: MasterContact,
): MasterContact {
  if (!existing) return incoming;

  return {
    ...incoming,
    email: incoming.email ?? existing.email,
    phone: incoming.phone ?? existing.phone,
    apolloPersonId: incoming.apolloPersonId ?? existing.apolloPersonId,
    apolloEnrichedAt: incoming.apolloEnrichedAt ?? existing.apolloEnrichedAt,
    apolloMatchConfidence: incoming.apolloMatchConfidence ?? existing.apolloMatchConfidence,
    sources: dedupeSources([...existing.sources, ...incoming.sources]),
  };
}
