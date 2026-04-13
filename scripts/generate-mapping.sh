#!/bin/bash
# generate-mapping.sh
# Auto-generates .specs/mapping.md from feature spec YAML frontmatter
# Run manually or via Cursor hook after spec changes

set -e

SPECS_DIR=".specs"
OUTPUT="$SPECS_DIR/mapping.md"
FEATURES_DIR="$SPECS_DIR/features"

# Colors for output (if terminal supports it)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if yq is installed
if ! command -v yq &> /dev/null; then
    echo -e "${YELLOW}Warning: yq not installed. Using grep fallback (less reliable).${NC}"
    echo -e "Install yq for better parsing: brew install yq"
    USE_YQ=false
else
    USE_YQ=true
fi

# Function to extract ONLY the first frontmatter block (between first two --- markers)
# Fixes a bug where sed -n '/^---$/,/^---$/p' could match --- horizontal rules
# deeper in the file body, causing incorrect parsing.
extract_frontmatter() {
    local file="$1"
    awk 'BEGIN{c=0} /^---$/{c++; if(c==2) exit; next} c==1{print}' "$file"
}

# Function to extract frontmatter value using yq
extract_with_yq() {
    local file="$1"
    local key="$2"
    local default="$3"
    
    value=$(extract_frontmatter "$file" | yq -r ".$key // \"$default\"" 2>/dev/null)
    # Strip leading/trailing whitespace and newlines
    value=$(echo "$value" | head -1 | xargs)
    echo "${value:-$default}"
}

# Function to extract frontmatter value using grep (fallback)
extract_with_grep() {
    local file="$1"
    local key="$2"
    local default="$3"
    
    value=$(extract_frontmatter "$file" | grep "^$key:" | head -1 | sed "s/^$key: *//")
    value=$(echo "$value" | head -1 | xargs)
    echo "${value:-$default}"
}

# Function to extract array values
extract_array() {
    local file="$1"
    local key="$2"
    
    if [ "$USE_YQ" = true ]; then
        extract_frontmatter "$file" | yq -r ".$key // [] | join(\", \")" 2>/dev/null
    else
        # Fallback: just show "see spec"
        echo "see spec"
    fi
}

# Start generating mapping.md
cat > "$OUTPUT" << 'HEADER'
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
HEADER

# Track counts
total=0
by_status_stub=0
by_status_specced=0
by_status_tested=0
by_status_implemented=0

# Find all feature specs
if [ -d "$FEATURES_DIR" ]; then
    while IFS= read -r -d '' spec; do
        # Check if file has frontmatter
        if head -1 "$spec" | grep -q "^---$"; then
            total=$((total + 1))
            
            # Extract values
            if [ "$USE_YQ" = true ]; then
                feature=$(extract_with_yq "$spec" "feature" "Unknown")
                domain=$(extract_with_yq "$spec" "domain" "unknown")
                source=$(extract_with_yq "$spec" "source" "-")
                status=$(extract_with_yq "$spec" "status" "stub")
                tests=$(extract_array "$spec" "tests")
                components=$(extract_array "$spec" "components")
            else
                feature=$(extract_with_grep "$spec" "feature" "Unknown")
                domain=$(extract_with_grep "$spec" "domain" "unknown")
                source=$(extract_with_grep "$spec" "source" "-")
                status=$(extract_with_grep "$spec" "status" "stub")
                tests="see spec"
                components="see spec"
            fi
            
            # Track by status
            case "$status" in
                stub) by_status_stub=$((by_status_stub + 1)) ;;
                specced) by_status_specced=$((by_status_specced + 1)) ;;
                tested) by_status_tested=$((by_status_tested + 1)) ;;
                implemented) by_status_implemented=$((by_status_implemented + 1)) ;;
            esac
            
            # Make relative path for link
            rel_path="${spec#./}"
            
            # Handle empty arrays
            [ -z "$tests" ] && tests="-"
            [ -z "$components" ] && components="-"
            
            # Escape pipes in values
            feature=$(echo "$feature" | sed 's/|/\\|/g')
            source=$(echo "$source" | sed 's/|/\\|/g')
            tests=$(echo "$tests" | sed 's/|/\\|/g')
            components=$(echo "$components" | sed 's/|/\\|/g')
            
            # Output row
            echo "| $domain | [$feature]($rel_path) | \`$source\` | $tests | $components | $status |" >> "$OUTPUT"
        fi
    done < <(find "$FEATURES_DIR" -name "*.feature.md" -print0 2>/dev/null | sort -z)
fi

# Add empty state if no features
if [ "$total" -eq 0 ]; then
    echo "| _No features yet_ | | | | | |" >> "$OUTPUT"
fi

# Add summary section
cat >> "$OUTPUT" << SUMMARY

---

## Summary

| Status | Count |
|--------|-------|
| stub | $by_status_stub |
| specced | $by_status_specced |
| tested | $by_status_tested |
| implemented | $by_status_implemented |
| **Total** | **$total** |

---

## By Status

SUMMARY

# Group by status
for status in "stub" "specced" "tested" "implemented"; do
    # Capitalize first letter (compatible with older bash)
    status_capitalized="$(echo "$status" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
    echo "### $status_capitalized" >> "$OUTPUT"
    echo "" >> "$OUTPUT"
    
    found=false
    if [ -d "$FEATURES_DIR" ]; then
        while IFS= read -r -d '' spec; do
            if head -1 "$spec" | grep -q "^---$"; then
                if [ "$USE_YQ" = true ]; then
                    spec_status=$(extract_with_yq "$spec" "status" "stub")
                    feature=$(extract_with_yq "$spec" "feature" "Unknown")
                else
                    spec_status=$(extract_with_grep "$spec" "status" "stub")
                    feature=$(extract_with_grep "$spec" "feature" "Unknown")
                fi
                
                if [ "$spec_status" = "$status" ]; then
                    rel_path="${spec#./}"
                    echo "- [$feature]($rel_path)" >> "$OUTPUT"
                    found=true
                fi
            fi
        done < <(find "$FEATURES_DIR" -name "*.feature.md" -print0 2>/dev/null | sort -z)
    fi
    
    if [ "$found" = false ]; then
        echo "_None_" >> "$OUTPUT"
    fi
    echo "" >> "$OUTPUT"
done

# Add design system section
cat >> "$OUTPUT" << 'DESIGN'
---

## Design System

See `.specs/design-system/tokens.md` for token reference.

### Documented Components

| Component | Status | Source |
|-----------|--------|--------|
DESIGN

# List design system components
if [ -d "$SPECS_DIR/design-system/components" ]; then
    for comp in "$SPECS_DIR/design-system/components"/*.md; do
        if [ -f "$comp" ] && [ "$(basename "$comp")" != "_template.md" ]; then
            comp_name=$(basename "$comp" .md)
            # Try to extract status from component doc
            comp_status="documented"
            if grep -q "Status.*Stub" "$comp" 2>/dev/null; then
                comp_status="stub"
            fi
            echo "| $comp_name | $comp_status | [doc]($comp) |" >> "$OUTPUT"
        fi
    done
fi

# Check if any components were found
if ! grep -q "^\| [a-z]" "$OUTPUT" 2>/dev/null; then
    echo "| _No components documented_ | | |" >> "$OUTPUT"
fi

# Final footer
cat >> "$OUTPUT" << 'FOOTER'

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
FOOTER

echo -e "${GREEN}Generated $OUTPUT with $total features${NC}"
