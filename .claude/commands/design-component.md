---
description: Document a component pattern in the design system
---

Document component: $ARGUMENTS

## Behavior

### If stub exists
1. Read actual component source code
2. Extract props, variants, states
3. Fill in stub template sections
4. Update status from "📝 Stub" to "✅ Documented"
5. Document design tokens used

### If no stub exists
1. Read component source code
2. Create new component doc from template
3. Fill in all sections
4. Mark as "✅ Documented"

## Options

- Single: `/design-component button`
- Multiple: `/design-component button card input`
- All stubs: `/design-component --all-stubs`

## Component Doc Structure

### Required
- Purpose
- Props/API (with types, defaults)
- Variants
- States

### Recommended
- Anatomy (ASCII diagram)
- Design tokens used
- Accessibility
- Usage examples

### Optional
- Related components
- Changelog
