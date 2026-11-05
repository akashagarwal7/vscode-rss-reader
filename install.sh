#!/usr/bin/env bash
# Build a .vsix and install it into VS Code and/or Cursor.  Usage: ./install.sh
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NAME="$(node -p "require('./package.json').name")"
DISPLAY="$(node -p "require('./package.json').displayName")"
VERSION="$(node -p "require('./package.json').version")"
VSIX_FILE="${NAME}-${VERSION}.vsix"

echo "==> ${DISPLAY} ${VERSION} → ${VSIX_FILE}"
npm install --silent
npx --yes @vscode/vsce package --out "${VSIX_FILE}"

# `code` on PATH may point at Cursor, so also try the VS Code app bundle directly.
VSCODE_APP_CLI="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
declare -a clis=()
[[ -x "$VSCODE_APP_CLI" ]] && clis+=("$VSCODE_APP_CLI")
command -v code &>/dev/null && clis+=("$(command -v code)")
command -v cursor &>/dev/null && clis+=("$(command -v cursor)")

installed=0
declare -a seen=()
for cli in "${clis[@]+"${clis[@]}"}"; do
  real="$(readlink -f "$cli" 2>/dev/null || echo "$cli")"
  if [[ " ${seen[*]-} " == *" $real "* ]]; then continue; fi
  seen+=("$real")
  echo "==> Installing with ${cli}…"
  "$cli" --install-extension "${VSIX_FILE}" --force
  installed=1
done

if [[ $installed -eq 0 ]]; then
  echo "No VS Code or Cursor CLI found. Install ${VSIX_FILE} via Extensions → ⋯ → Install from VSIX…"
  exit 1
fi
echo "✓ Installed. Reload the editor window (Developer: Reload Window)."
