#!/usr/bin/env bash
# Deploys the bh-systems Worker with DEPLOY_ID/SECRET placeholders in
# public/texml/*.xml substituted for real values, then restores the
# committed placeholders — so the real GAS deployment ID and webhook
# secret only ever exist in git as tokens, never as plaintext, even
# though wrangler needs the real values in the deployed assets.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${GAS_DEPLOY_ID:?Set GAS_DEPLOY_ID (the Apps Script deployment ID) in the environment or apps/bh-systems/.env}"
: "${WEBHOOK_SECRET:?Set WEBHOOK_SECRET (must match the adjuster Apps Script WEBHOOK_SECRET config) in the environment or apps/bh-systems/.env}"

TEXML_FILES=(public/texml/field-notes.xml public/texml/guided-intake.xml public/texml/single-stage-aigather.xml)
BACKUP_DIR="$(mktemp -d)"

restore() {
  for f in "${TEXML_FILES[@]}"; do
    cp "$BACKUP_DIR/$(basename "$f")" "$f"
  done
  rm -rf "$BACKUP_DIR"
}
trap restore EXIT

for f in "${TEXML_FILES[@]}"; do
  cp "$f" "$BACKUP_DIR/$(basename "$f")"
  sed -i.bak -e "s/DEPLOY_ID/${GAS_DEPLOY_ID}/g" -e "s/SECRET/${WEBHOOK_SECRET}/g" "$f"
  rm -f "$f.bak"
done

npx wrangler deploy

echo "Deployed. Checked-in TeXML placeholders restored."
