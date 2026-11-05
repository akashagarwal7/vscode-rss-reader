# CLAUDE.md

Built with the `vscode-extension` skill (`~/.claude/skills/vscode-extension`); see its `reference/` for webview,
screenshot and API notes.

## Verify

`npm run check && npm test && npm run test:integration`

## After changing the extension

Tests don't touch the copy of the extension installed in the editor. After any change to `src/` or `media/`, finish
by telling the user to (re)install it locally:

```sh
./install.sh
```

This builds a `.vsix` and installs it into VS Code and/or Cursor (note: `code` on PATH points at Cursor on this
machine). They then need to reload the editor window (**Developer: Reload Window**). Don't run it yourself unless
asked; it changes the user's editor.

## Releasing

Bump `version` in `package.json`, add a `CHANGELOG.md` entry, commit, push, then `./publish.sh` (requires
`vsce login akashagarwal`).
