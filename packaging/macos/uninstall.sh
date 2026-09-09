#!/bin/bash
set -euo pipefail

PREFIX="${DAUYS_PREFIX:-$HOME/Applications/DauysAgent}"
SUPPORT="$HOME/Library/Application Support/DauysAgent"
PLIST="$HOME/Library/LaunchAgents/com.dauys.agent.plist"
LABEL="com.dauys.agent"
UID_NUM="$(id -u)"

launchctl bootout "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true
rm -f "$PLIST"
rm -rf "$PREFIX"

if [[ "${1:-}" == "--purge" ]]; then
  rm -rf "$SUPPORT"
  echo "Агент удалён вместе с токеном и журналом."
else
  echo "Агент остановлен. Данные привязки оставлены в $SUPPORT"
  echo "Полная очистка: $0 --purge"
fi
