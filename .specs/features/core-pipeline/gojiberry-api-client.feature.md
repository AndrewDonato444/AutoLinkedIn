---
feature: GojiBerry API Client
domain: core-pipeline
source: src/api/gojiberry-client.ts
tests:
  - tests/api/gojiberry-client.test.ts
components: []
status: implemented
created: 2026-04-13
updated: 2026-04-13
---

# GojiBerry API Client

**Source File**: src/api/gojiberry-client.ts
**Design System**: N/A (no UI — script/library layer)

## Overview

Shell-based or script-based wrapper around the GojiBerry REST API (`https://ext.gojiberry.ai`). This is the foundation every other automation calls — lead discovery, enrichment, campaign analytics, and scheduled tasks all go through this client.

Handles auth (bearer token from `.env.local`), CRUD for leads (contacts), campaign retrieval, list retrieval, rate limit handling (100 req/min), and clear error reporting so the founder doesn't have to debug HTTP failures.

## Feature: GojiBerry API Client

### Scenario: Authenticate with bearer token from config
Given the founder has set `GOJIBERRY_API_KEY` in `.env.local`
When the API client initializes
Then it reads the bearer token from `.env.local`
And all subsequent requests include `Authorization: Bearer {token}` header

### Scenario: Reject startup when API key is missing
Given `.env.local` does not contain `GOJIBERRY_API_KEY`
When the API client initializes
Then it throws a `ConfigError` with message: "Missing GOJIBERRY_API_KEY in .env.local — grab your API key from GojiBerry settings"
And no API requests are made

### Scenario: Verify connection with health check
Given the API client has a valid bearer token
When the client runs a health check
Then it calls `GET /health`
And reports "Connected to GojiBerry" on success
And reports "Cannot reach GojiBerry API — check your internet and API key" on failure

### Scenario: Create a new lead
Given the API client is authenticated
When the founder's automation creates a lead with firstName, lastName, and profileUrl
Then the client sends `POST /v1/contact` with the lead data
And returns the created lead with its GojiBerry ID
And logs "Lead created: {firstName} {lastName}"

### Scenario: Create a lead with full profile data
Given the API client is authenticated
When the automation creates a lead with firstName, lastName, profileUrl, email, company, jobTitle, location, and fit score
Then the client sends `POST /v1/contact` with all provided fields
And returns the created lead with its GojiBerry ID

### Scenario: Reject lead creation with missing required fields
Given the API client is authenticated
When the automation tries to create a lead without a profileUrl
Then the client returns an error: "Lead requires firstName, lastName, and profileUrl"
And no API request is made

### Scenario: Get a single lead by ID
Given the API client is authenticated
And a lead exists in GojiBerry with ID "abc-123"
When the client fetches lead "abc-123"
Then it calls `GET /v1/contact/abc-123`
And returns the full lead details

### Scenario: Search leads with filters
Given the API client is authenticated
When the client searches for leads with filters (search term, date range, score range, intent type)
Then it calls `GET /v1/contact` with the matching query parameters
And returns the list of matching leads with pagination info

### Scenario: Search leads by warm score range
Given the API client is authenticated
When the client searches for leads with scoreFrom=70 and scoreTo=100
Then it calls `GET /v1/contact?scoreFrom=70&scoreTo=100`
And returns only leads in that score range

### Scenario: Update a lead with enrichment data
Given the API client is authenticated
And a lead exists with ID "abc-123"
When the automation updates the lead with fit score, intent signals, and personalized messages
Then the client sends `PATCH /v1/contact/abc-123` with the update payload
And returns the updated lead
And logs "Lead updated: {firstName} {lastName}"

### Scenario: Get lead counts by intent type
Given the API client is authenticated
When the client requests intent type breakdown
Then it calls `GET /v1/contact/intent-type-counts`
And returns a map of intent types to lead counts

### Scenario: List all campaigns
Given the API client is authenticated
When the client fetches campaigns
Then it calls `GET /v1/campaign`
And returns all campaigns with their status and metrics

### Scenario: List only active campaigns
Given the API client is authenticated
When the client fetches campaigns with activeOnly=true
Then it calls `GET /v1/campaign?activeOnly=true`
And returns only currently running campaigns

### Scenario: Get a single campaign by ID
Given the API client is authenticated
And a campaign exists with ID "camp-456"
When the client fetches campaign "camp-456"
Then it calls `GET /v1/campaign/camp-456`
And returns the full campaign details including metrics

### Scenario: List all lead lists
Given the API client is authenticated
When the client fetches lists
Then it calls `GET /v1/list`
And returns all lists with their lead counts

### Scenario: Get a single list with its leads
Given the API client is authenticated
And a list exists with ID "list-789"
When the client fetches list "list-789"
Then it calls `GET /v1/list/list-789`
And returns the list details with its leads

### Scenario: Handle rate limiting gracefully
Given the API client is authenticated
And the client has made 100 requests in the current minute
When the client makes another request
Then it waits until the rate limit window resets
And retries the request automatically
And logs "Rate limit hit — waiting {seconds}s before retrying"

### Scenario: Respect rate limit across batch operations
Given the API client is authenticated
When the automation processes a batch of 50 leads (creating + enriching = ~150 API calls)
Then the client paces requests to stay under 100 req/min
And processes all leads without hitting rate limit errors

### Scenario: Handle auth failure
Given the API client has an invalid or expired bearer token
When the client makes any API request
Then it receives a 401 response
And reports "GojiBerry API key is invalid or expired — check GOJIBERRY_API_KEY in .env.local"
And does not retry the request

### Scenario: Handle server errors with retry
Given the API client is authenticated
When the client makes a request and receives a 500/502/503 response
Then it retries up to 3 times with exponential backoff (1s, 2s, 4s)
And if all retries fail, reports "GojiBerry API is down — try again in a few minutes"

### Scenario: Handle network timeout
Given the API client is authenticated
When a request takes longer than 30 seconds
Then the client times out the request
And reports "Request timed out — GojiBerry may be slow, try again"

### Scenario: Handle 404 for missing resources
Given the API client is authenticated
When the client fetches a lead, campaign, or list that doesn't exist
Then it returns a clear "not found" result (not a crash)
And logs "Lead/Campaign/List {id} not found in GojiBerry"

## API Base Configuration

```
Base URL: https://ext.gojiberry.ai
Auth: Bearer token from GOJIBERRY_API_KEY in .env.local
Rate limit: 100 requests/minute
Timeout: 30 seconds per request
Retry: 3 attempts with exponential backoff for 5xx errors
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOJIBERRY_API_KEY` | Yes | Bearer token for GojiBerry API auth |
| `GOJIBERRY_BASE_URL` | No | Override API base URL (default: `https://ext.gojiberry.ai`) |
| `GOJIBERRY_RATE_LIMIT` | No | Override rate limit (default: 100 req/min) |
| `GOJIBERRY_TIMEOUT_MS` | No | Override request timeout in ms (default: 30000) |

## Module Structure

```
src/api/
├── gojiberry-client.ts     # Main client class — all API methods
├── types.ts                # TypeScript types for contacts, campaigns, lists
├── rate-limiter.ts         # Token bucket rate limiter (100 req/min)
└── errors.ts               # Custom error types (AuthError, RateLimitError, etc.)
```

## Public API Surface

```typescript
class GojiBerryClient {
  // Setup
  constructor(config?: { apiKey?: string; baseUrl?: string; rateLimit?: number; timeoutMs?: number })
  healthCheck(): Promise<boolean>

  // Leads (Contacts)
  createLead(lead: CreateLeadInput): Promise<Lead>
  getLead(id: string): Promise<Lead>
  searchLeads(filters?: LeadFilters): Promise<PaginatedLeads>
  updateLead(id: string, updates: UpdateLeadInput): Promise<Lead>
  getIntentTypeCounts(): Promise<Record<string, number>>

  // Campaigns
  getCampaigns(options?: { activeOnly?: boolean }): Promise<Campaign[]>
  getCampaign(id: string): Promise<Campaign>

  // Lists
  getLists(): Promise<List[]>
  getList(id: string): Promise<ListWithLeads>
}
```

## Learnings

_(none yet — will be populated after implementation)_
