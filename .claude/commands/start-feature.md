---
description: Sync with main branch and create new feature branch
---

Start feature: $ARGUMENTS

## Steps

### 1. Check Current State
- Current branch
- Uncommitted changes
- PR merged status

### 2. Handle Uncommitted Changes
If changes exist, ask:
- `stash` - Stash and continue
- `commit` - Commit with message
- `abort` - Cancel

### 3. Sync with Remote
```bash
git fetch origin
git checkout {main_branch}
git pull origin {main_branch}
```

### 4. Create Feature Branch
- Generate branch name from description
- Create and checkout

### 5. Ready
Confirm branch created and remind about `/spec-first`.

## Branch Naming

| Input | Branch |
|-------|--------|
| "user notifications" | feature/user-notifications |
| "fix: login bug" | fix/login-bug |
| "JIRA-1234 settings" | feature/JIRA-1234-settings |

## Error Handling

- Uncommitted changes: Ask stash/commit/abort
- Merge conflicts: Offer to help resolve
- Branch exists: Switch to it or create with suffix
