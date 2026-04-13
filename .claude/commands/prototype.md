---
description: Rapid prototyping - skip specs and tests
---

Prototype: $ARGUMENTS

## Behavior

- Do NOT create feature specs
- Do NOT write tests
- Do NOT update documentation
- Use mock/hardcoded data where needed
- Add `// TODO: Add specs and tests` comments
- Keep code isolated (easy to delete or formalize)

## Guidelines

1. **Speed over quality** - Get something working fast
2. **Isolation** - Don't deeply integrate with existing code
3. **Mark it** - Use TODO comments
4. **Disposable** - Be ready to throw it away

## When Done

If prototype is approved, use `/formalize` to convert to production code with full specs and tests.
