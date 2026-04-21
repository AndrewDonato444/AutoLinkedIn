/**
 * Mechanically synthesize { reasoning, signals[] } for the ultra-minimal
 * contacts using Apollo data we already have on disk. No external API calls.
 *
 * For contacts WITHOUT Apollo data, skip — they'll need ScrapingDog separately.
 *
 * Reads: data/reenrichment/input.json
 * Writes: data/reenrichment/synthesized.json (array of { id, profileBaseline })
 */
import fs from 'fs';

const input = JSON.parse(fs.readFileSync('data/reenrichment/input.json', 'utf8'));

function formatPercent(n) {
  if (n === null || n === undefined) return null;
  const pct = Math.round(n * 1000) / 10;
  if (Math.abs(pct) < 1) return null;
  return (pct > 0 ? '+' : '') + pct + '%';
}

/**
 * Produce 3-6 buying signals from Apollo org + person data.
 * Focuses on things that matter for a sales-recruiting pitch:
 * - Company size + revenue (did they hit scale where they'd hire a sales firm?)
 * - Growth trajectory (are they in a hiring moment?)
 * - Industry keywords (is this an ICP vertical?)
 * - Role (are they the decision-maker?)
 */
function buildSignals({ master, apollo }) {
  const sigs = [];
  const a = apollo;
  if (!a || a.minimal) return null;
  const org = a.organization;
  if (org) {
    if (org.estimated_num_employees) sigs.push(`${org.estimated_num_employees} employees`);
    if (org.organization_revenue_printed) sigs.push(`${org.organization_revenue_printed} revenue`);
    const growth = formatPercent(org.headcount_twelve_month_growth);
    if (growth) sigs.push(`${growth} headcount growth (12mo)`);
    // Vertical + PE / acquisition hints from keywords
    const relevantKw = (org.keywords || []).filter((k) => {
      const t = k.toLowerCase();
      return (
        t.includes('pe-backed') ||
        t.includes('pe backed') ||
        t.includes('private equity') ||
        t.includes('acquisition') ||
        t.includes('outside sales') ||
        t.includes('d2d') ||
        t.includes('door-to-door') ||
        t.includes('territory') ||
        t.includes('franchise') ||
        t.includes('residential roofing') ||
        t.includes('commercial roofing') ||
        t.includes('pest control') ||
        t.includes('hvac') ||
        t.includes('landscaping') ||
        t.includes('fire protection')
      );
    }).slice(0, 3);
    for (const kw of relevantKw) sigs.push(kw);
    if (org.industry && !sigs.some((s) => s.toLowerCase().includes(org.industry.toLowerCase()))) {
      sigs.push(`${org.industry} vertical`);
    }
  }
  // Role + seniority
  if (a.title && a.seniority) {
    sigs.push(`${a.title}${a.seniority === 'vp' || a.seniority === 'c_suite' ? ' (decision-maker)' : ''}`);
  }
  return sigs.filter(Boolean).slice(0, 6);
}

function buildReasoning({ master, apollo }) {
  const a = apollo;
  if (!a || a.minimal) return null;
  const parts = [];
  const role = a.title ?? master.jobTitle ?? 'role-unknown';
  parts.push(`${role} at ${master.company}`);
  const org = a.organization;
  if (org) {
    const orgBits = [];
    if (org.estimated_num_employees) orgBits.push(`${org.estimated_num_employees}-person`);
    if (org.industry) orgBits.push(org.industry);
    if (orgBits.length) parts.push(`a ${orgBits.join(' ')} company`);
    if (org.organization_revenue_printed) parts.push(`(${org.organization_revenue_printed} revenue)`);
    const growth = formatPercent(org.headcount_twelve_month_growth);
    if (growth) parts.push(`with ${growth} headcount growth over the last 12 months`);
    if (org.city && org.state) parts.push(`based in ${org.city}, ${org.state}`);
    // Mention obvious ICP fit from keywords
    const kw = (org.keywords || []).map((k) => k.toLowerCase());
    if (kw.some((k) => k.includes('pe-backed') || k.includes('private equity'))) {
      parts.push('PE-backed');
    }
    if (kw.some((k) => k.includes('outside sales') || k.includes('d2d') || k.includes('door-to-door'))) {
      parts.push('with an outside-sales / D2D model');
    }
  }
  return parts.join(', ').replace(/, with /, ' with ').replace(/, PE-backed/, ', PE-backed,').trim() + '.';
}

const out = [];
let synthesized = 0, needScrapingDog = 0;
for (const [id, data] of Object.entries(input)) {
  const signals = buildSignals(data);
  const reasoning = buildReasoning(data);
  if (!signals || signals.length === 0 || !reasoning) {
    needScrapingDog++;
    continue;
  }
  const icpLine = `ICP Score: ${data.master.icpScore}/100`;
  const reasoningLine = `Reasoning: ${reasoning}`;
  const signalsLine = `Signals: ${signals.join(', ')}`;
  const profileBaseline = `${icpLine}\n${reasoningLine}\n${signalsLine}\n`;
  out.push({
    id: Number(id),
    firstName: data.master.firstName,
    lastName: data.master.lastName,
    company: data.master.company,
    profileBaseline,
    synthesizedFrom: 'apollo',
  });
  synthesized++;
}

fs.writeFileSync('data/reenrichment/synthesized.json', JSON.stringify(out, null, 2));
console.log(`Synthesized: ${synthesized}`);
console.log(`Need ScrapingDog fallback: ${needScrapingDog}`);
console.log('');
console.log('Sample (first 2):');
for (const r of out.slice(0, 2)) {
  console.log(`id=${r.id} | ${r.firstName} ${r.lastName} @ ${r.company}`);
  console.log(r.profileBaseline);
}
