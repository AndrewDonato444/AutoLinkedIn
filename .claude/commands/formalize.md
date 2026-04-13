---
description: Convert prototype to production code with specs and tests
---

Formalize prototype: $ARGUMENTS

## Before Starting

Ask:
1. What parts should be kept vs changed?
2. Any new requirements discovered during prototyping?
3. What edge cases should we handle?

## Workflow (TDD)

```
SPEC → TEST (failing) → IMPLEMENT (until pass)
```

### 1. Review Prototype
- Identify what works
- Note production requirements
- Find `// TODO: Add specs and tests` comments

### 2. Create Feature Spec
- Write Gherkin scenarios based on prototype
- Add edge cases the prototype skipped
- Document in `.specs/features/`

### 3. Write Tests (Should Fail)
- Cover all scenarios
- Add edge case tests
- Document in `.specs/test-suites/`
- Update mapping.md

### 4. Implement to Production Standards
- Remove hardcoded/mock data
- Add proper error handling
- Follow existing patterns
- Add TypeScript types
- Loop until ALL tests pass

### 5. Clean Up
- Run all tests
- Remove prototype TODO comments
- Update mapping.md with final paths
