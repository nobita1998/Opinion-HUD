#!/bin/bash
# Auto-update data.json and push to GitHub Pages

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "[$(date)] Starting data update..."

# Activate virtual environment
source .venv/bin/activate

# Run build script
python backend/build_index.py

# Check if data.json changed
if git diff --quiet backend/data.json; then
  echo "[$(date)] No changes detected in data.json"
  exit 0
fi

# Commit and push
git add backend/data.json
git commit -m "Auto-update data.json - $(date '+%Y-%m-%d %H:%M:%S')"
git push origin main

echo "[$(date)] Update complete!"
