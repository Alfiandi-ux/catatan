#!/usr/bin/env bash
# Jalankan aplikasi Catatan di perangkat ini.
# Pemakaian: ./serve.sh [port]
set -e
cd "$(dirname "$0")"
PORT="${1:-8080}"
echo "Catatan berjalan di http://localhost:${PORT}"
echo "Tekan Ctrl+C untuk berhenti."
exec python3 -m http.server "$PORT" --bind 127.0.0.1
