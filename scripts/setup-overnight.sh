#!/bin/bash
# setup-overnight.sh
# Sets up the overnight automation launchd jobs
# Run this once to enable scheduled overnight runs

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[setup]${NC} $1"; }
success() { echo -e "${GREEN}[setup] ✓${NC} $1"; }
warn() { echo -e "${YELLOW}[setup] ⚠${NC} $1"; }
error() { echo -e "${RED}[setup] ✗${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LAUNCHD_DIR="$SCRIPT_DIR/launchd"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  SDD Overnight Automation Setup"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Check prerequisites
log "Checking prerequisites..."

if ! command -v agent &> /dev/null; then
    error "Cursor CLI not found!"
    echo "  Install with: curl https://cursor.com/install -fsS | bash"
    exit 1
fi
success "Cursor CLI found"

if ! command -v gh &> /dev/null; then
    warn "GitHub CLI (gh) not found - PR creation will be skipped"
    echo "  Install with: brew install gh"
else
    success "GitHub CLI found"
fi

if ! command -v yq &> /dev/null; then
    warn "yq not found - using fallback YAML parsing"
    echo "  Install with: brew install yq"
else
    success "yq found"
fi

# Create logs directory
log "Creating logs directory..."
mkdir -p "$PROJECT_DIR/logs"
success "Created $PROJECT_DIR/logs"

# Create .env.local if it doesn't exist
if [ ! -f "$PROJECT_DIR/.env.local" ]; then
    log "Creating .env.local from example..."
    cp "$PROJECT_DIR/.env.local.example" "$PROJECT_DIR/.env.local"
    success "Created .env.local - please edit to configure Slack/Jira"
else
    success ".env.local already exists"
fi

# Ask user if they want to install launchd jobs
echo ""
read -p "Do you want to install the launchd jobs for scheduled overnight runs? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    log "Installing launchd jobs..."
    
    # Create LaunchAgents directory if needed
    mkdir -p "$LAUNCH_AGENTS_DIR"
    
    # Copy plist files
    for plist in "$LAUNCHD_DIR"/*.plist; do
        if [ -f "$plist" ]; then
            filename=$(basename "$plist")
            
            # Unload if already loaded
            launchctl unload "$LAUNCH_AGENTS_DIR/$filename" 2>/dev/null || true
            
            # Copy to LaunchAgents
            cp "$plist" "$LAUNCH_AGENTS_DIR/$filename"
            
            # Load the job
            launchctl load "$LAUNCH_AGENTS_DIR/$filename"
            success "Installed $filename"
        fi
    done
    
    echo ""
    success "Launchd jobs installed!"
    echo ""
    echo "  Schedule:"
    echo "  • 10:00 PM - Mac stays awake (caffeinate)"
    echo "  • 10:30 PM - Nightly review (extract learnings)"
    echo "  • 11:00 PM - Overnight autonomous (scan → spec → implement → PR)"
    echo ""
    echo "  Logs: $PROJECT_DIR/logs/"
    echo ""
    echo "  To check status:"
    echo "    launchctl list | grep sdd"
    echo ""
    echo "  To uninstall:"
    echo "    ./scripts/uninstall-overnight.sh"
    
else
    log "Skipping launchd installation"
    echo ""
    echo "  You can run the scripts manually:"
    echo "    ./scripts/nightly-review.sh"
    echo "    ./scripts/overnight-autonomous.sh"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Next steps:"
echo "  1. Edit .env.local to configure Slack channel and Jira project"
echo "  2. Test manually: ./scripts/overnight-autonomous.sh"
echo "  3. Check logs: tail -f logs/overnight-autonomous.log"
echo "═══════════════════════════════════════════════════════════"
