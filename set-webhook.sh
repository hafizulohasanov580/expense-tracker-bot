#!/usr/bin/env bash
# Point your Telegram bot at the deployed edge function.
# Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... PANEL_URL=https://<ref>.supabase.co/functions/v1/app ./scripts/set-webhook.sh
set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
: "${TELEGRAM_WEBHOOK_SECRET:?set TELEGRAM_WEBHOOK_SECRET}"
: "${PANEL_URL:?set PANEL_URL, e.g. https://xxxx.supabase.co/functions/v1/app}"

curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${PANEL_URL}/bot" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode "allowed_updates=[\"message\",\"callback_query\"]" \
  --data-urlencode "drop_pending_updates=true"
echo
