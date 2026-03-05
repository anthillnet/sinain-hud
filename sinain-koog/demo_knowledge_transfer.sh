#!/usr/bin/env bash
# demo_knowledge_transfer.sh — Demonstrates sinain knowledge transfer flow.
#
# Scenario: Expert workspace has extracted a module → export it → import into
# a fresh (novice) workspace → verify the module stack and attribution.
#
# Usage:
#   ./demo_knowledge_transfer.sh <expert-workspace> <novice-workspace> <module-id>
#
# Example:
#   ./demo_knowledge_transfer.sh /mnt/openclaw-state /tmp/novice-workspace ocr-vision-pipeline

set -euo pipefail

EXPERT_WS="${1:?Usage: $0 <expert-workspace> <novice-workspace> <module-id>}"
NOVICE_WS="${2:?Usage: $0 <expert-workspace> <novice-workspace> <module-id>}"
MODULE_ID="${3:?Usage: $0 <expert-workspace> <novice-workspace> <module-id>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_PATH="/tmp/${MODULE_ID}.sinain-module.json"

echo "=== sinain Knowledge Transfer Demo ==="
echo ""
echo "Expert workspace:  $EXPERT_WS"
echo "Novice workspace:  $NOVICE_WS"
echo "Module to transfer: $MODULE_ID"
echo ""

# Step 1: Show expert's module info
echo "--- Step 1: Expert's module info ---"
python3 "$SCRIPT_DIR/module_manager.py" \
  --modules-dir "$EXPERT_WS/modules" info "$MODULE_ID"
echo ""

# Step 2: Export from expert workspace
echo "--- Step 2: Export module as portable bundle ---"
python3 "$SCRIPT_DIR/module_manager.py" \
  --modules-dir "$EXPERT_WS/modules" export "$MODULE_ID" \
  --output "$BUNDLE_PATH"
echo ""
echo "Bundle size: $(wc -c < "$BUNDLE_PATH") bytes"
echo ""

# Step 3: Ensure novice workspace has modules directory
echo "--- Step 3: Prepare novice workspace ---"
mkdir -p "$NOVICE_WS/modules" "$NOVICE_WS/memory"
echo "Created $NOVICE_WS/modules/"
echo ""

# Step 4: Import into novice workspace with activation
echo "--- Step 4: Import into novice workspace (with --activate) ---"
python3 "$SCRIPT_DIR/module_manager.py" \
  --modules-dir "$NOVICE_WS/modules" import "$BUNDLE_PATH" --activate
echo ""

# Step 5: Fire KG ingestion (optional, may fail if triple store not configured)
echo "--- Step 5: KG ingestion (optional) ---"
python3 "$SCRIPT_DIR/triple_ingest.py" \
  --memory-dir "$NOVICE_WS/memory" \
  --ingest-module "$MODULE_ID" \
  --modules-dir "$NOVICE_WS/modules" \
  --embed 2>/dev/null || echo "(triple store not available — skipped)"
echo ""

# Step 6: Verify module stack
echo "--- Step 6: Verify novice module stack ---"
python3 "$SCRIPT_DIR/module_manager.py" \
  --modules-dir "$NOVICE_WS/modules" stack
echo ""

# Step 7: Show imported module details
echo "--- Step 7: Imported module details ---"
python3 "$SCRIPT_DIR/module_manager.py" \
  --modules-dir "$NOVICE_WS/modules" info "$MODULE_ID"
echo ""

echo "=== Transfer complete ==="
echo ""
echo "The novice workspace now has the expert's '$MODULE_ID' module active."
echo "When sinain runs a heartbeat in the novice workspace, it will:"
echo "  1. Include transferred patterns in the effective playbook"
echo "  2. Tag them with [Transferred knowledge: ...]"
echo "  3. Cite the origin in suggestions and insights"
echo ""
echo "Bundle file: $BUNDLE_PATH"
