#!/bin/bash
# uninstall-overnight.sh
# Removes the overnight automation launchd jobs

set -e

GREEN='\033[0;32m'
NC='\033[0m'

success() { echo -e "${GREEN}[uninstall] ✓${NC} $1"; }

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

echo "Uninstalling SDD overnight automation..."

for label in "com.sdd.nightly-review" "com.sdd.overnight-autonomous" "com.sdd.caffeinate"; do
    plist="$LAUNCH_AGENTS_DIR/$label.plist"
    
    if [ -f "$plist" ]; then
        launchctl unload "$plist" 2>/dev/null || true
        rm "$plist"
        success "Removed $label"
    fi
done

echo ""
echo "Uninstall complete. The scripts are still available for manual use."
