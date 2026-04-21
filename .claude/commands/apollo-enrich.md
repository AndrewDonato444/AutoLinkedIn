# /apollo-enrich — Enrich master contacts with Apollo emails

Enrich contacts in `data/contacts.jsonl` with work emails from Apollo, via the Apollo MCP server. Runs safely: dry-run preview first, explicit approval to spend credits, hard budget caps.

## Usage

```
/apollo-enrich              # dry-run preview only
/apollo-enrich --apply      # actually spend credits (requires approval)
/apollo-enrich --apply --limit 5
```

## What This Command Does

1. **Verify Apollo MCP account** — call `apollo_users_api_profile` with `include_credit_usage=true`. Report the email and remaining credits. If the email doesn't look like the user's expected account, STOP and ask.
2. **Build the plan** — run `npx tsx src/contacts/cli/apollo-plan.cli.ts [--limit N]`. This filters the master through all safeguards (3 gates + 2 budget caps) and writes a plan JSON to `data/apollo-plans/<runId>.json`. Capture the file path from stdout.
3. **Show the plan to the user** — human-readable summary from stderr. Include: eligible count, projected credits, remaining budget, and a sample of the first 3-5 contacts about to be enriched.
4. **If no `--apply` flag** — stop here. Tell the user to re-run with `--apply` to spend credits.
5. **If `--apply` flag** — confirm with the user before spending. If they confirm:
   - Read the plan JSON
   - For each batch, call `mcp__8363dc0f-5336-4ff2-a865-599c6ad2c49b__apollo_people_bulk_match` with the batch's `details` array (pass the details directly — they're already in Apollo's expected shape)
   - Collect the raw MCP responses into an array (one per batch)
   - Write the array to `data/apollo-plans/<runId>-mcp-response.json`
   - Run `npx tsx src/contacts/cli/apollo-apply.cli.ts --plan <plan> --mcp-response <mcp-response>`
   - The apply CLI correlates by **normalized LinkedIn URL** (Apollo normalizes `https://www.linkedin.com/in/foo/` → `http://linkedin.com/in/foo`). Plan contacts with no matching Apollo record become `no-match` outcomes.
   - Report the summary (outcomes, credits used, any warnings)

## About the MCP response

The raw Apollo bulk_match response looks like:
```json
{
  "status": "success",
  "total_requested_enrichments": 5,
  "matches": [ { "id": "...", "linkedin_url": "...", "email": "...", "email_status": "verified", ... } ],
  "missing_records": 0,
  "credits_consumed": 5
}
```

Only these fields are consumed by the apply CLI: `matches[].linkedin_url`, `matches[].email`, `matches[].id`, `matches[].email_status`. Everything else is ignored. `email_status: "verified"` maps to `confidence: 1.0`.

**Default behavior:** we do NOT pass `reveal_personal_emails`. Work emails are included for free (1 credit per matched person); personal emails would cost extra.

## Safeguards Already Built In

These are enforced by `src/contacts/apollo-enricher.ts` — do not bypass them:

- **3 ghost gates**: skip contacts with no profileUrl, missing name/company, or already enriched
- **APOLLO_RUN_BUDGET** (env, default 50): hard cap per run
- **APOLLO_TOTAL_BUDGET** (env, default 500 — currently 1000 in .env.local): absolute cap across all runs
- **Idempotent**: no-match and no-email outcomes still mark contact as enriched (prevents re-calling the same dead URL)
- **Dry-run default**: without `--apply`, no MCP calls are made

## Why the plan/apply split?

Node subprocesses cannot call MCP tools directly. The plan CLI filters/budgets entirely in Node (safe, fast, testable). Claude does the MCP calls between plan and apply. The apply CLI writes the master + log. This makes the flow scheduled-task-compatible: a Claude scheduled task prompt `/apollo-enrich --apply` runs itself end-to-end.

## Files

- Plan CLI: `src/contacts/cli/apollo-plan.cli.ts`
- Apply CLI: `src/contacts/cli/apollo-apply.cli.ts`
- Core logic: `src/contacts/apollo-enricher.ts` (`planEnrichment`, `applyEnrichmentResults`)
- Log (append-only): `data/apollo-enrichment-log.jsonl`
