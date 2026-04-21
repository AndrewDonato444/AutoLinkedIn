---
feature: Master Contact Store with Apollo Enrichment
domain: core-pipeline
source:
  - src/contacts/types.ts
  - src/contacts/master-store.ts
  - src/contacts/rebuild-master.ts
  - src/contacts/apollo-enricher.ts
  - src/contacts/gojiberry-sync.ts
  - src/contacts/cli/rebuild-master.cli.ts
  - src/contacts/cli/apollo-enricher.cli.ts
  - src/contacts/cli/gojiberry-sync.cli.ts
tests:
  - tests/contacts/master-store.test.ts
  - tests/contacts/rebuild-master.test.ts
  - tests/contacts/apollo-enricher.test.ts
  - tests/contacts/gojiberry-sync.test.ts
components:
  - readMaster
  - writeMaster
  - mergeContact
  - rebuildMaster
  - enrichContacts
  - syncGojiberryState
design_refs: []
status: implemented
created: 2026-04-20
updated: 2026-04-21
---

# Master Contact Store with Apollo Enrichment

**Source Files**: `src/contacts/*.ts`
**Design System**: N/A (no UI — data infrastructure + CLI scripts)
**Depends on**: GojiBerry API Client, Apollo MCP tools, scan-log files in `data/scan-logs/`

## Overview

Establishes a **local, file-backed master record** for every contact we touch, so enrichment is done once and contacts can be placed into GojiBerry lists (or future channels) on demand. Today, contact state is split across three places: GojiBerry (mutable, schema-limited), scan-log JSON files (historical, immutable), and nowhere (Apollo-enriched emails, which we haven't captured yet). The master store unifies these, preserves provenance, and becomes the authoritative record for our own enrichment fields while still reading engagement state back from GojiBerry.

The master store is built from two reliable sources — GojiBerry API and scan-logs — with scan-log data taking precedence for fields that GojiBerry may have overwritten (e.g. the original ICP reasoning and signals from Claude, which can be lost if someone PATCHes `profileBaseline`).

Apollo email enrichment is gated behind **explicit safeguards** because credits are finite and ghost calls (calls that return no useful data) burn credits with zero return. Every Apollo call must clear a three-gate check (LinkedIn URL present, name+company present, not already enriched), must fit under a per-run budget cap, and must pass through a dry-run preview unless the user types `--apply`.

## Storage

**Path**: `data/contacts.jsonl`

**Format**: JSONL (one JSON object per line).

**Rationale**: Git-friendly diffs, streaming reads (no full-file parse), appendable, 223 contacts is under 1 MB so no pagination needed. Follows the repo precedent of committing `data/scan-logs/*.json` to git (no PII policy change).

**Git**: Committed to git. The file reveals names and LinkedIn URLs (public info) but not emails until Apollo runs; if emails become sensitive later, move to gitignored. Documented as a deliberate choice in this spec.

## Schema

Every line in `contacts.jsonl` is a JSON object with this shape:

```typescript
interface MasterContact {
  // Identity
  id: number;                    // GojiBerry contact id (integer, canonical)
  firstName: string;
  lastName: string;
  fullName: string;              // denormalized for grep
  profileUrl: string;            // LinkedIn URL, required
  company: string | null;
  jobTitle: string | null;
  location: string | null;

  // Our enrichment (owned by us, not pushed from GojiBerry)
  icpScore: number | null;       // 0-100, parsed from profileBaseline or scan log
  fit: 'qualified' | 'unknown' | 'out-of-scope' | null;
  intentSignals: string[];       // extracted from profileBaseline "Signals:" line
  intentType: string | null;
  reasoning: string | null;      // extracted from profileBaseline "Reasoning:" paragraph
  personalizedMessages: Array<{ content: string; stepNumber: number }>;

  // Apollo enrichment (null until enriched)
  email: string | null;
  phone: string | null;
  apolloPersonId: string | null;
  apolloEnrichedAt: string | null;    // ISO 8601
  apolloMatchConfidence: number | null; // from Apollo response

  // GojiBerry engagement state (read-only; synced from GojiBerry)
  gojiberryState: {
    listId: number | null;
    campaignStatus: string | null;
    readyForCampaign: boolean;
    bounced: boolean;
    unsubscribed: boolean;
    updatedAt: string | null;    // ISO 8601, from GojiBerry's updatedAt
  };

  // Provenance
  sources: Array<{
    type: 'gojiberry' | 'scan-log';
    ref: string;                 // e.g. 'api' or 'scan-2026-04-16.json'
    fetchedAt: string;           // ISO 8601
  }>;

  // Bookkeeping
  masterUpdatedAt: string;       // ISO 8601, last time we touched this row
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOJIBERRY_API_KEY` | Yes | N/A | Bearer token for GojiBerry |
| `APOLLO_API_KEY` | Yes (for enrichment) | N/A | Apollo API key for MCP calls |
| `APOLLO_RUN_BUDGET` | No | `50` | Hard cap on Apollo credits per enrichment run |
| `APOLLO_TOTAL_BUDGET` | No | `500` | Absolute cap across all runs, tracked in `data/apollo-enrichment-log.jsonl` |

## CLI Surface

Three scripts, all run via `node --loader tsx/esm` or compiled. All accept `--help`.

### `rebuild-master.ts`

```
Usage: rebuild-master [--source-of-truth gojiberry|scan-log] [--dry-run]

Rebuilds data/contacts.jsonl by merging GojiBerry contacts + scan-log archives.
Default: prefers scan-log reasoning/signals over GojiBerry's (GojiBerry is lossy).
```

### Apollo enrichment — plan/apply split (MCP-compatible)

Node subprocesses cannot call MCP tools directly. Apollo enrichment is therefore
split into two headless CLIs plus a Claude-Code slash command that glues them
together by calling the MCP tool between them.

#### `apollo-plan.cli.ts`

```
Usage: apollo-plan [--limit N]

Reads master, applies all safeguards (3 ghost-call gates + per-run + total
budget caps), batches eligible contacts into groups of 10, and writes a plan
JSON to `data/apollo-plans/<runId>.json`. Prints the plan file path to stdout.
```

#### `apollo-apply.cli.ts`

```
Usage: apollo-apply --plan <plan.json> (--mcp-response <file> | --results <file>)

Takes the plan + raw Apollo MCP bulk_match response, correlates by normalized
LinkedIn URL (via `correlateApolloResponse`), writes updated master, appends to
`data/apollo-enrichment-log.jsonl`. Exits with a summary of outcomes.
```

#### `/apollo-enrich` slash command

Defined in `.claude/commands/apollo-enrich.md`. Orchestrates plan → Claude-driven
MCP call → apply. Safe for Claude-Code scheduled tasks. Always requires `--apply`
to spend credits; dry-run by default.

#### `apollo-enricher.ts` (legacy one-shot API, test-only)

The core library still exports `enrichContacts({ _apollo, apply, ... })` that
combines plan + apply internally — kept for tests that want to inject an
`ApolloClient` mock without modeling the plan/apply handshake.

### `gojiberry-sync.ts`

```
Usage: gojiberry-sync

Pulls fresh GojiBerry engagement state (listId, campaignStatus, bounced,
unsubscribed) for every contact in master and writes back to data/contacts.jsonl.
Read-only on GojiBerry side; never PATCHes.
```

## Feature: Master Store Rebuild

### Scenario: Initial rebuild populates master from GojiBerry and scan-logs

Given `data/contacts.jsonl` does not exist
And GojiBerry has 223 contacts
And `data/scan-logs/` contains 6 scan log files
When `rebuild-master` runs
Then it fetches all 223 contacts from GojiBerry via paginated `searchLeads`
And it reads every scan log file and collects every unique `gojiberry_id` / `id`
And it writes `data/contacts.jsonl` with one line per unique contact
And each line includes `sources` listing every file that referenced that contact

### Scenario: Scan-log reasoning overrides GojiBerry profileBaseline on conflict

Given a contact exists in both GojiBerry and a scan log
And GojiBerry's `profileBaseline` is `"ICP Score: 98/100"` (truncated — reasoning was overwritten)
And the scan log's entry for this contact has full `signals` and `score` fields
When `rebuild-master` runs with `--source-of-truth scan-log` (the default)
Then the master row's `reasoning` field is reconstructed from the scan log's data
And the master row's `intentSignals` comes from the scan log
And the master row's `icpScore` comes from the scan log's `score` field
And GojiBerry provides only the fields scan logs don't have (jobTitle, company, location, personalizedMessages)

### Scenario: Contact in GojiBerry but not in any scan log is preserved

Given a contact exists in GojiBerry but not in any scan log (e.g. manually added pre-automation)
When `rebuild-master` runs
Then the master row is written using only GojiBerry data
And `sources` contains a single `{type: 'gojiberry', ref: 'api', fetchedAt: ...}` entry
And fields without data (e.g. `reasoning`, `intentSignals`) are null/empty arrays

### Scenario: Re-running rebuild is idempotent

Given `data/contacts.jsonl` already exists with 223 contacts
When `rebuild-master` runs again with no new data
Then the file is rewritten with the same 223 contacts
And previous Apollo enrichment fields (`email`, `apolloEnrichedAt`) are preserved — never clobbered by rebuild
And `masterUpdatedAt` is refreshed but `apolloEnrichedAt` is not

### Scenario: Rebuild with dry-run shows diff without writing

Given `data/contacts.jsonl` exists
When `rebuild-master --dry-run` runs
Then the script prints a summary: `N added, M updated, K unchanged`
And no file on disk is modified

## Feature: Apollo Enrichment with Safeguards

### Scenario: Dry run is the default — no credits spent without --apply

Given master has 150 contacts missing email with valid LinkedIn URLs
When `apollo-enricher` runs with no flags
Then no Apollo MCP tool is called
And the output shows: "DRY RUN — 150 contacts would be enriched (est. 150 credits, within APOLLO_RUN_BUDGET=50: NO)"
And the output lists the 50 contacts that would be enriched if `--apply` were added (first 50 by ICP score)
And the process exits 0

### Scenario: Budget cap enforced before any Apollo call

Given `APOLLO_RUN_BUDGET=50`
And master has 150 enrichable contacts
When `apollo-enricher --apply` runs
Then exactly 50 contacts are enriched (highest ICP score first)
And the 51st-150th contacts are not called
And the log notes: "Stopped at budget cap 50/50"

### Scenario: Total budget cap enforced across runs

Given `APOLLO_TOTAL_BUDGET=500`
And `data/apollo-enrichment-log.jsonl` shows 480 credits already consumed
And the current run would spend 50 credits
When `apollo-enricher --apply` runs
Then only 20 credits are spent (500 - 480)
And the process exits with a warning: "APOLLO_TOTAL_BUDGET nearly exhausted"

### Scenario: Ghost call prevention — skip contacts missing LinkedIn URL

Given 5 contacts in master have `profileUrl` that is null or empty
When `apollo-enricher --apply` runs
Then those 5 contacts are filtered out before any Apollo call
And the skipped count is logged: "5 skipped: no profileUrl"

### Scenario: Ghost call prevention — skip contacts missing name+company

Given 3 contacts in master have `company` null or `firstName` empty
When `apollo-enricher --apply` runs
Then those 3 contacts are filtered out before any Apollo call
And the skipped count is logged: "3 skipped: missing name or company"

### Scenario: Idempotent — never re-enrich the same contact

Given 30 contacts in master already have `apolloEnrichedAt` set
When `apollo-enricher --apply` runs
Then those 30 contacts are filtered out before any Apollo call
And the skipped count is logged: "30 skipped: already enriched"

### Scenario: Apollo match returns email — write to master

Given contact id=5151727 in master has `profileUrl="https://linkedin.com/in/adam-bultman-199a736"` and `email=null`
And Apollo `people_match` returns `{ email: "adam@hollandroofing.com", personId: "apollo_abc", confidence: 0.92 }`
When `apollo-enricher --apply` processes this contact
Then master row 5151727 is updated with `email="adam@hollandroofing.com"`, `apolloPersonId="apollo_abc"`, `apolloEnrichedAt="<now>"`, `apolloMatchConfidence=0.92`
And the enrichment log records: `{ contactId: 5151727, linkedinUrl: "...", credits: 1, outcome: "success", email: "adam@..." }`

### Scenario: Apollo match returns no email — log and continue

Given contact id=5151728 in master has valid LinkedIn URL
And Apollo `people_match` returns `{ email: null }` (matched person but no email on file)
When `apollo-enricher --apply` processes this contact
Then master row 5151728 is updated with `apolloEnrichedAt="<now>"`, `apolloPersonId=<id>`, `email=null`
And the enrichment log records: `{ contactId: 5151728, credits: 1, outcome: "no-email" }`
And the contact is marked enriched (won't be retried) — this is intentional to prevent ghost loops

### Scenario: Apollo no-match — log and continue

Given contact id=5151729 in master has valid LinkedIn URL
And Apollo `people_match` returns `{ match: false }`
When `apollo-enricher --apply` processes this contact
Then master row 5151729 is updated with `apolloEnrichedAt="<now>"`, `email=null`, `apolloPersonId=null`
And the enrichment log records: `{ contactId: 5151729, credits: 1, outcome: "no-match" }`

### Scenario: Bulk match used for batches of 10+

Given 40 contacts need enrichment and pass all gates
When `apollo-enricher --apply` runs
Then `apollo_people_bulk_match` is called in batches of 10 (4 calls)
Rather than 40 individual `people_match` calls
And the enrichment log records each batch separately with batch size

### Scenario: Apollo API error — do not mark contact as enriched

Given the Apollo MCP tool throws a network error for contact id=5151730
When `apollo-enricher --apply` processes this contact
Then master row 5151730 is NOT updated (apolloEnrichedAt remains null)
And the enrichment log records: `{ contactId: 5151730, outcome: "error", error: "<message>", credits: 0 }`
And the next contact is still processed (one failure does not abort the run)

### Scenario: Correlate Apollo response to plan contacts by normalized URL

Given a plan contains contact `4893075` with LinkedIn URL `https://www.linkedin.com/in/luke-gaeta-636244375/`
And Apollo's raw bulk_match response returns `http://www.linkedin.com/in/luke-gaeta-636244375` (https→http, no trailing slash)
When `apollo-apply` processes the response
Then it correlates the response back to contact `4893075` via `normalizeLinkedInUrl`
Because Apollo's bulk_match response does NOT echo back the `id` correlator we sent. Correlation is by URL, normalized for protocol / subdomain / slash / query / fragment variations. Plan contacts with no match in the Apollo response become `no-match` outcomes.

## Shared utilities

- **`src/utils/linkedin-url.ts`** — `normalizeLinkedInUrl(url)` canonicalizes to `http://linkedin.com/<path>`; `extractLinkedInSlug(url)` returns just the `in/<slug>` identifier. Used across apollo correlation, GojiBerry dedup (in `icp-lead-discovery.ts`), and scan-log matching.

### Scenario: --limit caps the number considered for testing

Given master has 150 enrichable contacts
When `apollo-enricher --apply --limit 3` runs
Then exactly 3 contacts are enriched
And the remaining 147 are untouched

## Feature: GojiBerry Engagement Sync

### Scenario: Pulls engagement state into master

Given master has 223 contacts
And GojiBerry shows contact 4724299 as `bounced=true`
When `gojiberry-sync` runs
Then master row 4724299 is updated with `gojiberryState.bounced=true`
And master row 4724299's `masterUpdatedAt` is refreshed
And Apollo fields on that row are not touched

### Scenario: Contact removed from GojiBerry — flag in master

Given master has contact id=4700000 that was deleted in GojiBerry since last sync
When `gojiberry-sync` runs
Then master row 4700000 is not removed
But `gojiberryState.updatedAt` notes it as deleted (via a new `deletedFromGojiberry: true` flag)

### Scenario: Sync never PATCHes GojiBerry

Given `gojiberry-sync` runs for any contact
Then it only issues GET requests to `/v1/contact` and `/v1/contact/:id`
And it never issues POST or PATCH
This is verified by mocking the client and asserting `updateLead` is not called

## Enrichment Log Schema

`data/apollo-enrichment-log.jsonl` (append-only):

```typescript
interface EnrichmentLogEntry {
  timestamp: string;           // ISO 8601
  runId: string;               // uuid per run, for grouping
  contactId: number;
  linkedinUrl: string;
  credits: number;             // typically 1 per match attempt
  outcome: 'success' | 'no-email' | 'no-match' | 'error' | 'skipped-gate';
  email?: string;              // only when outcome=success
  apolloPersonId?: string;
  error?: string;              // only when outcome=error
  batchSize?: number;          // when bulk-matched
}
```

## Open Decisions Resolved

| # | Question | Resolution |
|---|----------|------------|
| 1 | JSONL vs per-contact files | **JSONL** for v1. 223 contacts is small; JSONL is simpler, streamable, git-diffable. Revisit if contacts exceed ~10k. |
| 2 | Apollo dry-run | **REQUIRED**. `--apply` must be explicit. No "skip dry run" env var — this is non-negotiable per user. |
| 3 | Git commit `contacts.jsonl` | **Committed** — follows precedent of `data/scan-logs/*.json`. No PII policy change. Can move to gitignored later if policy shifts. |

## Dependencies

- **GojiBerryClient** (`src/api/gojiberry-client.ts`): use existing `searchLeads` paginated fetch and `getLead` single fetch.
- **Apollo MCP tools**: `mcp__8363dc0f-5336-4ff2-a865-599c6ad2c49b__apollo_people_match` (single), `mcp__...__apollo_people_bulk_match` (bulk up to 10). Access requires an MCP-enabled context; for tests, abstract behind an `ApolloClient` interface that can be mocked.
- **Scan logs** (`data/scan-logs/*.json`): variable schema. Some files have `contacts`, others have `newContacts` + `existingContacts`. Normalizer handles both.

## Test IDs

| Prefix | Module |
|--------|--------|
| SVC | `master-store.ts`, `rebuild-master.ts`, `apollo-enricher.ts`, `gojiberry-sync.ts` |

Tests live in `tests/contacts/`.

## UI Mockup

No UI. CLI output mockup for `apollo-enricher` (dry run):

```
$ node src/contacts/apollo-enricher.ts

=== Apollo Enrichment — DRY RUN ===

Gate check:
  Master contacts: 223
  Already enriched: 0
  Missing LinkedIn URL: 0
  Missing name/company: 2
  Eligible for enrichment: 221

Budget:
  APOLLO_RUN_BUDGET: 50
  APOLLO_TOTAL_BUDGET: 500 (480 consumed, 20 remaining)
  Would spend this run: 20 credits (capped by total budget)

Top 20 contacts (by ICP score) that would be enriched:
   1. 4893075 — Luke Gaeta @ Pye-Barker Fire & Safety (ICP: 98)
   2. 4893071 — Derek Couture @ Tecta America (ICP: 95)
   3. 4893135 — Jacob Borg @ PestCo Holdings (ICP: 92)
   ...
  20. 5151741 — <name> @ <company> (ICP: 78)

To proceed, re-run with --apply:
  node src/contacts/apollo-enricher.ts --apply
```

## Learnings

### 2026-04-21

- **MCP tool responses can exceed Claude's token limits; extract compact JSON before apply.** Apollo `people_bulk_match` returns ~80KB per batch of 10. The harness writes the raw response to a temp file and returns a path. Don't read the raw file into Claude's context; use Node to parse and extract just `{id, linkedin_url, email, email_status}` to `data/apollo-plans/<runId>-mcp-response.json`, then run apply.
- **Apollo correlation is by normalized URL, not by the `id` field.** Apollo's `apollo_people_bulk_match` schema documents `id` as "optional unique identifier... used to match results," but the response does NOT echo it back. Correlate by `normalizeLinkedInUrl(match.linkedin_url)`.
- **Apollo fuzzy-matches by name/company when the LinkedIn URL doesn't hit — those are intentional no-matches.** We sent `/in/michaeldmyers`, Apollo returned `/in/mike-myers-308010186`. Our correlator correctly rejected this as no-match. The "missed correlations" metric is a feature, not a bug.
- **Scan-log signal extraction depends on format heuristics.** Three production formats coexist in `profileBaseline`: structured (`Reasoning:`/`Signals:` labels), paragraph (`Score: X. ... Signals: a, b, c.`), and ultra-minimal (just the score). `parseProfileBaseline` handles all three; tests cover each case with a real production example.
- **"Richer source wins" merge beats "scan-log always wins."** Some April-20 scan logs have only a `keySignal` summary; the GojiBerry profileBaseline has 5 structured signals for the same contact. Rule: the source with MORE signals wins, falling back to scan-log on ties. Preserves both Luke Gaeta's case (GojiBerry truncated, scan-log rich) and Cory Van Wagenen's case (scan-log short, GojiBerry rich).
- **Idempotent "already-enriched" gates freeze partial data.** April-14 scan produced 48 contacts with `profileBaseline = "ICP Score: X/100"` only. Because `fit` was set, every subsequent enrichment run skipped them. Net effect: data frozen at thinnest point for the contact's life. Solution: re-enrich via Apollo raw-response data (free, already on disk) + ScrapingDog fallback for the 9 contacts Apollo fuzzy-missed.
- **Retry ceiling via `apolloErrorCount` + `MAX_APOLLO_ERROR_RETRIES`.** Without a cap, flaky URLs get retried forever because `apolloEnrichedAt` stays null. Ceiling: after 3 errors, mark as enriched-with-no-match anyway. Prevents ghost retry loops.
- **Plan/apply split is the right shape for MCP-driven ops.** Headless plan CLI → Claude MCP calls → headless apply CLI. Works in Claude-Code scheduled tasks without requiring API keys. Applied identically in `/apollo-enrich` and `/regenerate-messages`.
- **`--list-id <n>` filter respects human judgment.** When targeting a campaign (e.g., SalesEdge = 14507), the filter adds a fourth "not-in-list" gate to `selectEligible`. Used to enrich the live campaign's 141 contacts across 3 runs without touching contacts the user hasn't enrolled yet.
