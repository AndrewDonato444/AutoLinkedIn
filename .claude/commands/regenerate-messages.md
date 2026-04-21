# /regenerate-messages — Regenerate LinkedIn messages from master contact store

Regenerate `personalizedMessages` for contacts in the master store using Claude-in-session as the generator. Mirrors the `/apollo-enrich` plan → Claude → apply pattern, so it's compatible with Claude-Code scheduled tasks and doesn't require `ANTHROPIC_API_KEY`.

## Usage

```
/regenerate-messages                                      # queue contacts missing messages
/regenerate-messages --list-id 14507                      # target a specific GojiBerry list
/regenerate-messages --force                              # overwrite existing messages
/regenerate-messages --contains gojiberry                 # surgical fix: only messages mentioning "gojiberry"
/regenerate-messages --limit 5                            # cap run size
/regenerate-messages --apply                              # actually write to GojiBerry (else dry run)
```

## What This Command Does

1. **Build the plan** — run `npx tsx src/messages/cli/regen-plan.cli.ts [flags]`. Filters master contacts through all gates (qualified, has signals, not already sent in campaign, list/contains matches) and writes a plan to `data/regen-plans/<runId>.json`. Capture the file path from stdout.

2. **Show the plan to the user** — eligible count, gate breakdown, top 5 candidates with their signals.

3. **If no `--apply`** — stop here. Tell the user to re-run with `--apply` to proceed.

4. **If `--apply`** — confirm with the user before writing. If they approve:
   - Read the plan JSON (`data/regen-plans/<runId>.json`)
   - For each candidate, generate a personalized LinkedIn connection request message using:
     - The contact's `firstName`, `lastName`, `jobTitle`, `company`
     - Their `intentSignals` (specific things to reference)
     - Their `reasoning` (why they're a fit — for grounding)
     - The `ICP_DESCRIPTION` and `VALUE_PROPOSITION` from `.env.local`
     - Tone: casual; max length: 300 characters
   - Write results to `data/regen-plans/<runId>-messages.json` as an array of `{ contactId: number, message: string }`
   - Run `npx tsx src/messages/cli/regen-apply.cli.ts --plan <plan-file> --messages <results-file>` to push to GojiBerry
   - Report the summary

## Message Requirements (enforced by prompt, not code)

When generating messages, Claude MUST:

- **Reference at least one specific buying signal** from `intentSignals` — not generic platitudes
- **Reference `VALUE_PROPOSITION` verbatim or close to it** — this is the ONLY product/service you may mention
- **NEVER invent product, platform, tool, or company names** — if VALUE_PROPOSITION doesn't fit the signal cleanly, keep the pitch generic rather than fabricating one. This prevents the "GojiBerry hallucination" bug.
- **Sound like a real human wrote it** after actually reading the profile — no template phrases like "I noticed we're both in..." or "I came across your profile..."
- **Stay under 300 characters** (LinkedIn connection request limit)

## Safeguards (baked into the plan gate)

- Skips contacts with `fit !== 'qualified'`
- Skips contacts with empty `intentSignals` (would produce a generic message)
- Skips contacts where step-1 message has already been **sent in campaign** (check `gojiberryState.campaignStatus` for a `{type: 'message', stepNumber: >= 1}` event) — overwriting stored copy won't un-send the message, and could confuse future audits
- By default, skips contacts that already have a message — use `--force` to overwrite, or `--contains TOKEN` for surgical fixes

## Files

- Plan CLI: `src/messages/cli/regen-plan.cli.ts`
- Apply CLI: `src/messages/cli/regen-apply.cli.ts`
- Core logic: `src/messages/regenerate.ts` (`planRegeneration`, `applyMessages`)
- Plans + results: `data/regen-plans/<runId>.json`, `data/regen-plans/<runId>-messages.json`

## Why a slash command (not a cron script)

Message generation has always been LLM-driven. The legacy `message-generation.ts` uses the Anthropic SDK and requires `ANTHROPIC_API_KEY` — fine for cron but duplicates what's already available for free inside a Claude-Code session. This command uses Claude-in-session as the generator, matching the pattern we use for `/apollo-enrich` and keeping the architecture consistent.
