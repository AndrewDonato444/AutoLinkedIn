import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const { defaultMessageGenerator } = await import('../src/automations/message-generation.ts');

const id = Number(process.argv[2]);
if (!id) {
  console.error('Usage: tsx scripts/preview-message.mjs <contactId>');
  process.exit(1);
}

const lines = fs.readFileSync('data/contacts.jsonl', 'utf8').trim().split('\n');
const contacts = lines.map((l) => JSON.parse(l));
const c = contacts.find((x) => x.id === id);
if (!c) {
  console.error(`Contact ${id} not found in master`);
  process.exit(1);
}

console.log('=== Lead context ===');
console.log(`${c.firstName} ${c.lastName} | ${c.jobTitle} @ ${c.company}`);
console.log('Signals:');
for (const s of c.intentSignals) console.log(`  - ${s}`);
console.log('');

if (c.personalizedMessages?.length > 0) {
  console.log('=== CURRENT message in GojiBerry ===');
  console.log(c.personalizedMessages[0].content);
  console.log('');
}

const leadLike = {
  id: String(c.id),
  firstName: c.firstName,
  lastName: c.lastName,
  profileUrl: c.profileUrl,
  company: c.company ?? undefined,
  jobTitle: c.jobTitle ?? undefined,
  location: c.location ?? undefined,
  intentSignals: c.intentSignals,
  fit: c.fit ?? undefined,
};

const msg = await defaultMessageGenerator(
  leadLike,
  process.env.ICP_DESCRIPTION,
  process.env.VALUE_PROPOSITION,
  { tone: 'casual', maxLength: 300 },
);

console.log('=== NEW preview (not written) ===');
console.log(msg);
console.log('');
console.log(`Length: ${msg.length}/300`);
console.log(`Mentions "GojiBerry": ${/gojiberry/i.test(msg)}`);
console.log(`Mentions recruit/hire/SalesEdge: ${/recruit|hire|hiring|salesedge/i.test(msg)}`);
