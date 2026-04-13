# GojiBerry Auto — Vision

## Overview

GojiBerry Auto is an **automation-first system** that connects Claude AI (via MCP) to LinkedIn through GojiBerry AI as the execution middleware. It replaces the manual LinkedIn outreach loop — searching leads, writing messages, sending, waiting, guessing — with a set of AI-driven automations that run continuously with human approval gates only where needed.

The user describes their ideal customer in plain English. The system finds high-intent leads across the web, enriches them with real buying signals, generates hyper-personalized outreach, launches campaigns on LinkedIn, analyzes performance, and iterates — all through conversational prompts to Claude, with GojiBerry handling the LinkedIn execution layer.

**This is not a traditional app with a UI.** It's a series of automations orchestrated through Claude MCP connectors, scheduled tasks, and the GojiBerry AI platform. The user touches the system only when approving outreach or reviewing results.

## Target Users

| User | Description |
|------|-------------|
| **Founders / solopreneurs** | Running their own outbound, need scale without hiring SDRs |
| **Sales professionals** | Doing LinkedIn outreach daily, want to 10x reply rates |
| **Agency operators** | Managing outreach for multiple clients, need repeatable workflows |

## Value Proposition

Move from 2-5% reply rates (manual, generic outreach) to significantly higher engagement through:
- AI-powered lead discovery based on real intent signals (not just job titles)
- Deep personalization from actual online activity, not templates
- Continuous optimization — the system analyzes what worked and tells you what to improve
- Near-zero manual effort after initial ICP description

## Key Capabilities

| Capability | Description | Priority |
|------------|-------------|----------|
| **Lead Discovery** | Claude searches the web for high-intent leads matching ICP, creates contacts in GojiBerry via `POST /v1/contact` | P0 |
| **Lead Enrichment** | Enrich profiles with intent signals, online activity, buying signals; update via `PATCH /v1/contact/{id}` with fit scores and personalized messages | P0 |
| **Personalized Messaging** | Generate hyper-personalized LinkedIn messages per lead based on real signals, stored as `personalizedMessages` on the contact | P0 |
| **Campaign Management** | Retrieve and monitor campaigns via `GET /v1/campaign`; organize leads into lists via `GET /v1/list` | P0 |
| **Pipeline Overview** | Real-time view of pipeline via contact search (`GET /v1/contact` with filters), intent type counts (`GET /v1/contact/intent-type-counts`), and campaign status | P1 |
| **Performance Analytics** | Weekly campaign reports — analyze campaigns, compare performance, detect patterns across intent types and scores | P1 |
| **Warm Lead Lists** | Build targeted lists from intent signals using score/date/intent filters on `GET /v1/contact` | P1 |
| **Continuous Optimization** | Update intent signals, refine ICP, improve messaging based on results — feedback loop through contact updates | P2 |
| **Scheduled Automations** | Recurring tasks: daily lead scanning, weekly reports, campaign health checks via Claude Code scheduled tasks | P2 |

## GojiBerry API Surface

The automation layer talks to GojiBerry via its REST API (`https://ext.gojiberry.ai`). Bearer token auth, 100 req/min rate limit.

### Contacts (core data model)
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/contact` | POST | Create new contact (firstName, lastName, profileUrl required; email, phone, company, jobTitle, location, fit, personalizedMessages optional) |
| `/v1/contact` | GET | Search/filter contacts (page, limit, search, agent, dateFrom/To, scoreFrom/To, intentType, listId) |
| `/v1/contact/{id}` | GET | Get single contact details |
| `/v1/contact/{id}` | PATCH | Update contact (fit score, state, personalizedMessages, etc.) |
| `/v1/contact/intent-type-counts` | GET | Contact counts grouped by intent type |

### Campaigns
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/campaign` | GET | List all campaigns (filter by activeOnly) |
| `/v1/campaign/{id}` | GET | Get single campaign details |

### Lists
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/list` | GET | All lists with contact counts |
| `/v1/list/{id}` | GET | Single list with its contacts |

### System
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Service health check |

## Tech Stack

| Layer | Technology |
|-------|------------|
| **AI Orchestration** | Claude Pro (claude.ai) via MCP connectors / Claude Code |
| **Execution Middleware** | GojiBerry AI REST API (`ext.gojiberry.ai`) + MCP server (`mcp.gojiberry.ai`) |
| **LinkedIn Access** | Via GojiBerry's LinkedIn integration (user links their account in GojiBerry) |
| **Automation Runtime** | Claude Code scheduled tasks / shell scripts |
| **Lead Data** | GojiBerry platform (contacts, lists, campaigns, intent scoring) |
| **Configuration** | `.env.local` for API keys, ICP definitions, schedule configs |
| **Scripts** | Shell scripts for automation loops (build-loop, overnight) |

## Architecture

```
┌──────────────────┐     MCP       ┌──────────────────┐    LinkedIn    ┌──────────────┐
│   Claude AI      │◄─────────────►│  GojiBerry AI    │◄─────────────►│   LinkedIn   │
│  (orchestrator)  │  connector    │  (execution      │   integration │  (profiles,  │
│                  │               │   middleware)     │               │   messages,  │
│ - Web search     │               │                  │               │   campaigns) │
│ - Intent scoring │  REST API     │ - Contact CRUD   │               │              │
│ - Message gen    │◄─────────────►│ - Campaign mgmt  │               │              │
│ - Analytics      │  ext.goji...  │ - List mgmt      │               │              │
│ - Optimization   │               │ - Intent scoring │               │              │
└──────────────────┘               └──────────────────┘               └──────────────┘
        ▲
        │ Scheduled tasks / cron
        │
┌──────────────────┐
│  Automation Layer │
│                  │
│ - Daily: scan    │
│   for new leads  │
│ - Weekly: perf   │
│   reports        │
│ - On-demand:     │
│   enrich + msg   │
│ - Approval gates │
│   before send    │
└──────────────────┘
```

### Data Flow

```
1. DISCOVER    Claude searches web for ICP-matching leads
                    │
2. CREATE      POST /v1/contact → lead enters GojiBerry
                    │
3. ENRICH      Claude researches lead → PATCH /v1/contact/{id}
               (fit score, intent signals, personalized messages)
                    │
4. ORGANIZE    Leads grouped into lists → GET /v1/list
                    │
5. CAMPAIGN    Leads added to campaign → launched on LinkedIn
               (via GojiBerry UI — one-click launch)
                    │
6. ANALYZE     GET /v1/campaign + GET /v1/contact (filtered)
               Claude generates performance report
                    │
7. OPTIMIZE    Update ICP criteria, refine messaging approach
               Loop back to step 1
```

## Design Principles

1. **Automation-first** — No custom UI to build. Everything runs through Claude conversations, MCP tools, and scheduled tasks. GojiBerry provides the dashboard.
2. **Human-in-the-loop at approval gates** — Automations propose, humans approve before outreach ships. Nothing sends without confirmation.
3. **Conversational interface** — Every insight that used to require a spreadsheet export becomes a Claude prompt.
4. **Intent over demographics** — Lead quality is measured by buying signals and online activity, not just job titles and company size.
5. **Compounding intelligence** — Each campaign's results feed back into lead scoring and message optimization. The system gets smarter over time.
6. **Minimal touch** — After initial ICP setup, the user only interacts when approving outreach or reviewing weekly reports.

## Out of Scope

- Building a custom web UI or dashboard (GojiBerry's platform handles this)
- Direct LinkedIn API integration (GojiBerry handles this)
- CRM replacement (this is an outreach automation layer, not a CRM)
- Email outreach (LinkedIn-focused; email could be a future addition)
- Multi-platform social selling (LinkedIn only for v1)
- Building MCP server infrastructure (GojiBerry provides this at mcp.gojiberry.ai)

## Key Workflows

### Setup (once)
1. Connect Claude to GojiBerry via MCP connector (mcp.gojiberry.ai)
2. Link LinkedIn account to GojiBerry
3. Define ICP in plain English to Claude
4. Configure scheduled automations (daily scans, weekly reports)

### Daily loop (automated)
1. Claude scans for new high-intent leads matching ICP
2. Creates contacts in GojiBerry (`POST /v1/contact`)
3. Enriches each with intent signals (`PATCH /v1/contact/{id}`)
4. Generates personalized messages per lead
5. User reviews/approves → campaign launches in GojiBerry
6. Performance data feeds back into optimization

### Weekly review (automated report)
1. Pull all campaigns (`GET /v1/campaign`)
2. Pull contact metrics by intent type (`GET /v1/contact/intent-type-counts`)
3. Analyze: what worked, what didn't, patterns
4. Recommend: ICP refinements, messaging adjustments, campaign changes

---

*Created: 2026-04-13*
*Status: Initial vision — no strategy.md or personas yet*
