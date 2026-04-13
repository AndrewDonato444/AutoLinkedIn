---
description: Sync test documentation with actual tests
---

Update test docs: $ARGUMENTS

## Behavior

For specified test file (or all):

1. **Read** test file(s)
2. **Extract** test names and describe blocks
3. **Update/create** corresponding `.specs/test-suites/` doc
4. **Assign** sequential test IDs if missing
5. **Update** coverage summary table
6. **Add** change log entry with today's date
7. **Update** test-suites/README.md totals

## Test Doc Format

```markdown
# Test Suite: [Component]

**Test File**: tests/...
**Last Updated**: YYYY-MM-DD

## Coverage Summary
| Category | Tests | Status |
|----------|-------|--------|
| Rendering | X | ✅ |
| Total | X | ✅ |

## Test Catalog

### [Category]
| ID | Test Name | Verifies |
|----|-----------|----------|
| XX-001 | test name | what it checks |

## Change Log
| Date | Change | Tests Affected |
```

## Usage

- `/update-test-docs for DealCard`
- `/update-test-docs for all components`
