---
description: Run tests and reconcile counts vs documentation
---

Verify test counts: $ARGUMENTS

## Process

### 1. Run Test Suite
Execute test runner to get actual counts.

### 2. Compare Against Documentation
Check:
- `.specs/mapping.md` - Test ID Quick Reference
- `.specs/test-suites/README.md` - Coverage Overview
- Individual `.specs/test-suites/*.tests.md` files

### 3. Report Discrepancies

```markdown
## Test Count Verification

**Total Tests**: 437 (docs say 422)

### Discrepancies by Suite
| Test Suite | Documented | Actual | Diff |
|------------|------------|--------|------|
| DealCard | 15 | 18 | +3 ⚠️ |

### New Tests Not Documented
- `should show priority indicator` (not in docs)

### Documented Tests Not Found
- NS-015: removed?
```

### 4. Reconcile
Update documentation to match reality.

## Options

- Full: `/verify-test-counts` - Run all tests
- Specific: `/verify-test-counts for DealCard`
- Quick: `/verify-test-counts --quick` - Compare without running
