/**
 * Fetches LinkedIn profiles from ScrapingDog for contacts missing Apollo data,
 * synthesizes { reasoning, signals[] } from the profile, appends to
 * data/reenrichment/synthesized.json.
 *
 * Usage: node scripts/fetch-scrapingdog.mjs
 * Requires: SCRAPINGDOG_API_KEY in .env.local
 * Cost: 50 credits per successful profile scrape.
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const KEY = process.env.SCRAPINGDOG_API_KEY;
if (!KEY) {
  console.error('Missing SCRAPINGDOG_API_KEY');
  process.exit(1);
}

const input = JSON.parse(fs.readFileSync('data/reenrichment/input.json', 'utf8'));
const synthesized = JSON.parse(fs.readFileSync('data/reenrichment/synthesized.json', 'utf8'));
const alreadyHave = new Set(synthesized.map((r) => r.id));

const toFetch = Object.entries(input)
  .filter(([id]) => !alreadyHave.has(Number(id)))
  .map(([id, data]) => ({ id: Number(id), master: data.master }));

console.log(`Need to fetch: ${toFetch.length} profiles`);
console.log(`Estimated cost: ${toFetch.length * 50} ScrapingDog credits`);
console.log('');

function extractSlug(url) {
  const m = url?.match(/linkedin\.com\/in\/([a-z0-9-_%]+)/i);
  return m ? m[1] : null;
}

async function scrape(slug) {
  const url = `https://api.scrapingdog.com/profile?api_key=${KEY}&id=${encodeURIComponent(slug)}&type=profile&premium=true`;
  const res = await fetch(url);
  if (res.status === 202) return { pending: true };
  if (!res.ok) return { error: `${res.status} ${res.statusText}` };
  const body = await res.json();
  if (Array.isArray(body) && body.length > 0) return body[0];
  return body;
}

function buildFromProfile(profile, master) {
  const signals = [];
  const reasoningBits = [];
  const role = profile.headline || profile.title || master.jobTitle || 'role-unknown';
  reasoningBits.push(`${role} at ${master.company}`);
  if (profile.location) reasoningBits.push(`based in ${profile.location}`);

  // Experience — current + immediate prior
  const exp = profile.experience || [];
  if (exp[0]) {
    const yrs = exp[0].duration ? ` (${exp[0].duration})` : '';
    signals.push(`${exp[0].position || 'current role'} at ${exp[0].company_name || master.company}${yrs}`);
  }
  if (exp[1] && exp[1].company_name !== (exp[0]?.company_name ?? master.company)) {
    signals.push(`Previously ${exp[1].position} at ${exp[1].company_name}`);
  }

  // About → grab first ~200 chars as a signal-like summary if present
  if (profile.about) {
    const about = profile.about.slice(0, 200).trim();
    reasoningBits.push(about);
  }

  // Connections / followers as weak signal
  if (profile.followers && profile.followers > 1000) {
    signals.push(`${profile.followers}+ LinkedIn followers`);
  }

  if (signals.length === 0) return null;
  const reasoning = reasoningBits.join('. ') + '.';
  return {
    id: master.id,
    firstName: master.firstName,
    lastName: master.lastName,
    company: master.company,
    profileBaseline: `ICP Score: ${master.icpScore}/100\nReasoning: ${reasoning}\nSignals: ${signals.join(', ')}\n`,
    synthesizedFrom: 'scrapingdog',
  };
}

const newResults = [];
const failed = [];
for (const { id, master } of toFetch) {
  const slug = extractSlug(master.profileUrl);
  if (!slug) {
    failed.push({ id, reason: 'no-slug' });
    continue;
  }
  try {
    const p = await scrape(slug);
    if (p.error) {
      failed.push({ id, reason: p.error });
      continue;
    }
    if (p.pending) {
      failed.push({ id, reason: '202-pending (retry later)' });
      continue;
    }
    const result = buildFromProfile(p, master);
    if (!result) {
      failed.push({ id, reason: 'no-usable-data' });
      continue;
    }
    newResults.push(result);
    console.log(`  ✓ ${id} | ${master.firstName} ${master.lastName}`);
  } catch (err) {
    failed.push({ id, reason: err.message });
  }
}

// Merge with existing synthesized
const allResults = [...synthesized, ...newResults];
fs.writeFileSync('data/reenrichment/synthesized.json', JSON.stringify(allResults, null, 2));

console.log('');
console.log(`Added: ${newResults.length}`);
console.log(`Failed: ${failed.length}`);
if (failed.length > 0) {
  console.log('Failures:');
  for (const f of failed) console.log(`  ${f.id}: ${f.reason}`);
}
console.log(`\nTotal synthesized (now): ${allResults.length} of ${Object.keys(input).length}`);
