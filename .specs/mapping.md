# Feature ↔ Test ↔ Component Mapping

_Auto-generated from feature specs. Do not edit directly._
_Regenerate with: `./scripts/generate-mapping.sh`_

## Legend

| Status | Meaning |
|--------|---------|
| stub | Spec created, not yet tested |
| specced | Spec complete with scenarios |
| tested | Tests written |
| implemented | Feature complete |

---

## Features

| Domain | Feature | Source | Tests | Components | Status |
|--------|---------|--------|-------|------------|--------|
| automation | [Campaign Health Monitor](.specs/features/automation/campaign-health-monitor.feature.md) | `src/automations/campaign-health-monitor.ts` | tests/automations/campaign-health-monitor.test.ts | - | implemented |
| automation | [Daily Lead Scan Automation](.specs/features/automation/daily-lead-scan.feature.md) | `src/automations/daily-lead-scan.ts` | tests/automations/daily-lead-scan.test.ts | - | implemented |
| automation | [Morning Briefing](.specs/features/automation/morning-briefing.feature.md) | `src/automations/morning-briefing.ts` | tests/automations/morning-briefing.test.ts | - | implemented |
| automation | [Weekly Performance Report](.specs/features/automation/weekly-performance-report.feature.md) | `src/automations/weekly-performance-report.ts` | tests/automations/weekly-performance-report.test.ts | - | implemented |
| core-pipeline | [GojiBerry API Client](.specs/features/core-pipeline/gojiberry-api-client.feature.md) | `src/api/gojiberry-client.ts` | tests/api/gojiberry-client.test.ts | - | implemented |
| core-pipeline | [Hybrid Lead Enrichment with ScrapingDog](.specs/features/core-pipeline/hybrid-enrichment-scrapingdog.feature.md) | `src/automations/lead-enrichment.ts` | tests/automations/lead-enrichment.test.ts | - | implemented |
| core-pipeline | [ICP-Based Lead Discovery](.specs/features/core-pipeline/icp-lead-discovery.feature.md) | `src/automations/icp-lead-discovery.ts` | tests/automations/icp-lead-discovery.test.ts | - | implemented |
| core-pipeline | [Lead Enrichment + Intent Scoring](.specs/features/core-pipeline/lead-enrichment-intent-scoring.feature.md) | `src/automations/lead-enrichment.ts` | tests/automations/lead-enrichment.test.ts | - | implemented |
| core-pipeline | [Master Contact Store with Apollo Enrichment](.specs/features/core-pipeline/master-contact-store.feature.md) | `- src/contacts/types.ts` | tests/contacts/master-store.test.ts, tests/contacts/rebuild-master.test.ts, tests/contacts/apollo-enricher.test.ts, tests/contacts/gojiberry-sync.test.ts | readMaster, writeMaster, mergeContact, rebuildMaster, enrichContacts, syncGojiberryState | implemented |
| core-pipeline | [Personalized Message Generation](.specs/features/core-pipeline/personalized-message-generation.feature.md) | `src/automations/message-generation.ts` | tests/automations/message-generation.test.ts | - | implemented |
| intelligence-layer | [Campaign Performance Analytics](.specs/features/intelligence-layer/campaign-performance-analytics.feature.md) | `src/automations/campaign-performance-analytics.ts` | tests/automations/campaign-performance-analytics.test.ts | - | implemented |
| intelligence-layer | [Intent Type Breakdown](.specs/features/intelligence-layer/intent-type-breakdown.feature.md) | `src/automations/intent-type-breakdown.ts` | tests/automations/intent-type-breakdown.test.ts | - | stub |
| intelligence-layer | [Warm Lead List Builder](.specs/features/intelligence-layer/warm-lead-list-builder.feature.md) | `src/automations/warm-lead-list-builder.ts` | tests/automations/warm-lead-list-builder.test.ts | - | implemented |
| intelligence | [Pipeline Overview Report](.specs/features/intelligence/pipeline-overview-report.feature.md) | `src/automations/pipeline-overview-report.ts` | tests/automations/pipeline-overview-report.test.ts | - | implemented |
| optimization | [ICP Refinement from Results](.specs/features/optimization/icp-refinement-from-results.feature.md) | `src/automations/icp-refinement.ts` | tests/automations/icp-refinement.test.ts | - | implemented |
| optimization | [Lead Quality Feedback Loop](.specs/features/optimization/lead-quality-feedback-loop.feature.md) | `src/automations/lead-quality-feedback-loop.ts` | tests/automations/lead-quality-feedback-loop.test.ts | - | implemented |
| optimization | [Message Style Optimization](.specs/features/optimization/message-style-optimization.feature.md) | `src/automations/message-style-optimization.ts` | tests/automations/message-style-optimization.test.ts | - | implemented |

---

## Summary

| Status | Count |
|--------|-------|
| stub | 1 |
| specced | 0 |
| tested | 0 |
| implemented | 16 |
| **Total** | **17** |

---

## By Status

### Stub

- [Intent Type Breakdown](.specs/features/intelligence-layer/intent-type-breakdown.feature.md)

### Specced

_None_

### Tested

_None_

### Implemented

- [Campaign Health Monitor](.specs/features/automation/campaign-health-monitor.feature.md)
- [Daily Lead Scan Automation](.specs/features/automation/daily-lead-scan.feature.md)
- [Morning Briefing](.specs/features/automation/morning-briefing.feature.md)
- [Weekly Performance Report](.specs/features/automation/weekly-performance-report.feature.md)
- [GojiBerry API Client](.specs/features/core-pipeline/gojiberry-api-client.feature.md)
- [Hybrid Lead Enrichment with ScrapingDog](.specs/features/core-pipeline/hybrid-enrichment-scrapingdog.feature.md)
- [ICP-Based Lead Discovery](.specs/features/core-pipeline/icp-lead-discovery.feature.md)
- [Lead Enrichment + Intent Scoring](.specs/features/core-pipeline/lead-enrichment-intent-scoring.feature.md)
- [Master Contact Store with Apollo Enrichment](.specs/features/core-pipeline/master-contact-store.feature.md)
- [Personalized Message Generation](.specs/features/core-pipeline/personalized-message-generation.feature.md)
- [Campaign Performance Analytics](.specs/features/intelligence-layer/campaign-performance-analytics.feature.md)
- [Warm Lead List Builder](.specs/features/intelligence-layer/warm-lead-list-builder.feature.md)
- [Pipeline Overview Report](.specs/features/intelligence/pipeline-overview-report.feature.md)
- [ICP Refinement from Results](.specs/features/optimization/icp-refinement-from-results.feature.md)
- [Lead Quality Feedback Loop](.specs/features/optimization/lead-quality-feedback-loop.feature.md)
- [Message Style Optimization](.specs/features/optimization/message-style-optimization.feature.md)

---

## Design System

See `.specs/design-system/tokens.md` for token reference.

### Documented Components

| Component | Status | Source |
|-----------|--------|--------|

---

## How This File Works

This file is **auto-generated** from feature spec YAML frontmatter.

**Do not edit this file directly.** Instead:
1. Update the feature spec's YAML frontmatter
2. Run `./scripts/generate-mapping.sh` (or it runs automatically via Cursor hook)

### Frontmatter Format

```yaml
---
feature: Feature Name
domain: domain-name
source: path/to/source.tsx
tests:
  - path/to/test.ts
components:
  - ComponentName
status: stub | specced | tested | implemented
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```
