#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_DIR="/var/wwww/guido-chatbot/twilio-chatbot"
LOG_FILE="$PROJECT_DIR/weekly-saludtools-import.log"

mkdir -p "$PROJECT_DIR"
exec >> "$LOG_FILE" 2>&1

echo
echo "===== Inicio importacion semanal: $(date '+%Y-%m-%d %H:%M:%S %Z') ====="

cd "$PROJECT_DIR"

NODE_BIN="$(command -v node || true)"
PM2_BIN="$(command -v pm2 || true)"

if [[ -z "$NODE_BIN" || -z "$PM2_BIN" ]]; then
    echo "ERROR: no se encontro node o pm2 en el PATH de cron."
    exit 1
fi

echo "Deteniendo guido-worker..."
"$PM2_BIN" stop guido-worker || true

restart_worker() {
    echo "Iniciando guido-worker..."
    "$PM2_BIN" start guido-worker || true
    echo "===== Fin importacion semanal: $(date '+%Y-%m-%d %H:%M:%S %Z') ====="
}

trap restart_worker EXIT

echo "Ejecutando importacion de Saludtools..."
"$NODE_BIN" scripts/import-saludtools-bulk.mjs
