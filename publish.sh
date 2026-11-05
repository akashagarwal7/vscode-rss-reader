#!/usr/bin/env bash
# Test, build and publish to the VS Code Marketplace.  Usage: ./publish.sh
# Requires `npx @vscode/vsce login akashagarwal` beforehand.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NAME="$(node -p "require('./package.json').name")"
PUBLISHER="$(node -p "require('./package.json').publisher")"
VERSION="$(node -p "require('./package.json').version")"

echo "==> Publishing ${PUBLISHER}.${NAME} ${VERSION}"
npm install --silent
npm test --silent
# vscode:prepublish type-checks and bundles.
npx --yes @vscode/vsce publish
echo "✓ Published v${VERSION}: https://marketplace.visualstudio.com/items?itemName=${PUBLISHER}.${NAME}"
