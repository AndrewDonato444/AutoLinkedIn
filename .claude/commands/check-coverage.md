---
description: Compare specs against tests to find gaps
---

Check coverage: $ARGUMENTS

## Behavior

1. **Read** the specified feature spec (or all specs)
2. **Read** related test suite docs
3. **Compare** Gherkin scenarios to documented tests
4. **Report** coverage status

## Output

```markdown
## Coverage Report: [Feature]

**Feature Spec**: .specs/features/{path}
**Test Suite**: .specs/test-suites/{path}

### Covered Scenarios ✅
| Scenario | Tests |
|----------|-------|
| [name] | XX-001, XX-002 |

### Uncovered Scenarios ⚠️
| Scenario | Suggested Tests |
|----------|-----------------|
| [name] | Test for X, Y |

### Orphan Tests ❓
Tests without corresponding scenarios.

### Coverage Score
- Scenarios: X/Y (Z%)
```

## After Report

Ask: "Want me to add tests for the uncovered scenarios?"

If yes: Write missing tests, update docs, re-run check.
