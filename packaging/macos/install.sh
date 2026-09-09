#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN_SRC="$HERE/dauys-agent"
PREFIX="${DAUYS_PREFIX:-$HOME/Applications/DauysAgent}"
SUPPORT="$HOME/Library/Application Support/DauysAgent"
LOG_DIR="$HOME/Library/Logs"
PLIST="$HOME/Library/LaunchAgents/com.dauys.agent.plist"
LABEL="com.dauys.agent"
UID_NUM="$(id -u)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Агент ставится только на macOS." >&2
  exit 1
fi
if [[ ! -x "$BIN_SRC" ]]; then
  echo "Нет бинарника $BIN_SRC. Сначала: pnpm build:agent" >&2
  exit 1
fi

mkdir -p "$PREFIX" "$SUPPORT" "$LOG_DIR" "$(dirname "$PLIST")"
chmod 700 "$SUPPORT"
cp "$BIN_SRC" "$PREFIX/dauys-agent"
chmod 755 "$PREFIX/dauys-agent"
codesign --force --sign - "$PREFIX/dauys-agent" >/dev/null 2>&1 || true

launchctl bootout "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.dauys.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PREFIX}/dauys-agent</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${SUPPORT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DAUYS_STANDALONE</key>
    <string>true</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/dauys-agent.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/dauys-agent.log</string>
</dict>
</plist>
EOF

launchctl bootstrap "gui/${UID_NUM}" "$PLIST"

echo "Рядом установлен и запущен."
echo "  бинарник: $PREFIX/dauys-agent"
echo "  логи:     $LOG_DIR/dauys-agent.log"
echo "  данные:   $SUPPORT"
echo
echo "Код привязки появится в диалоге (или в логе)."
echo "Перепривязка: $PREFIX/dauys-agent --reset"
echo "Новый код:    launchctl kickstart -k gui/${UID_NUM}/${LABEL} после $PREFIX/dauys-agent --pair"
echo "Снять:        $HERE/uninstall.sh"
