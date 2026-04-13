---
description: Review code against senior engineering standards
---

Review: $ARGUMENTS

## Check Categories

### JavaScript Fundamentals
- Proper `this` binding
- Correct iteration methods (no await in forEach)
- Shallow vs deep copy awareness
- Async patterns (Promise.all for parallel)
- Error handling on async operations

### TypeScript
- NO `any` in production
- Explicit return types on exports
- Utility types (Partial, Pick, Omit)
- Discriminated unions for state

### React
- Key prop usage (stable, unique)
- useMemo/useCallback appropriately
- useEffect dependencies complete
- useEffect cleanup
- State collocated properly

### Architecture
- UI components abstracted (could swap libraries)
- Configuration over hardcoding
- Route protection centralized

### Git
- Atomic commits
- Meaningful messages

### CSS
- Centering techniques correct
- Mobile-first responsive

### Testing
- Behavior tested, not implementation
- Error states covered

### Security
- Input validation
- XSS prevention

## Output

```markdown
## Code Review: [File]

### Critical Issues 🚩
Must fix before merge.

### Warnings ⚠️
Should fix.

### Suggestions 💡
Nice to have.

### Quality Score
Ready for PR: ✅/❌
```
