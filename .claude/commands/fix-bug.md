---
description: Fix a bug with proper regression testing
---

Fix bug: $ARGUMENTS

## Workflow

### 1. Understand
- Check `.specs/features/` for expected behavior
- If no spec exists, ask: "What should the correct behavior be?"

### 2. Locate
- Find relevant tests in `.specs/test-suites/`
- Check if existing tests should have caught this

### 3. Reproduce
- Write a failing test that captures the bug
- This test should FAIL before the fix

### 4. Fix
- Make minimal code change to fix
- Avoid unrelated refactoring

### 5. Verify
- Run new test (should pass now)
- Run related tests (should still pass)

### 6. Document
- Add test to test suite doc
- Format: `{PREFIX}-{NUM} | Regression: {bug description}`
- Add change log entry

## If No Spec Exists

1. Ask what correct behavior should be
2. Add scenario to feature spec
3. Then proceed with fix
