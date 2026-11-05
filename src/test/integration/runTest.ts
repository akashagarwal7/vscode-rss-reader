import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/** Create a throwaway workspace for the test run. */
function makeWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rss-feed-curator-it-'));
  writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  return dir;
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../../..');
  const workspace = makeWorkspace();
  // A short user-data dir: deep project paths overflow VS Code's IPC socket path limit on macOS.
  const userData = mkdtempSync(path.join(tmpdir(), 'vsud-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rssc-data-'));
  mkdirSync(path.join(userData, 'User'), { recursive: true });
  // Keep the test run from popping real OS notifications.
  writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({ 'rssCurator.notifications.system': false, 'rssCurator.notifications.editor': false }),
  );
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    launchArgs: [workspace, `--user-data-dir=${userData}`, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: { TEST_WORKSPACE: workspace, RSS_CURATOR_DATA_DIR: dataDir },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
